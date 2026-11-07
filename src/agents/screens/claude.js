/**
 * Claude Code screen knowledge: activity, owned dialogs, composer drafts and
 * the native /model and /effort pickers. The shared loops live in
 * src/babysit/activity.js and src/control/terminal.js.
 */
import { clean, pane_tail, unsupported, wait_for } from '../../control/terminal_kit.js'

/**
 * Activity from Claude's footer, once the shared interrupt scan found nothing.
 * @param {{ screen: string[], footer: string }} pane - ANSI-free rows; footer is the last 8 joined
 * @returns {'idle'|'waiting'|null}
 */
const activity = ( { screen, footer } ) => {

    // A completed foreground reply can leave background shells or
    // monitors alive: "2 shells, 2 monitors · ← for agents", sometimes
    // followed by more segments ("· 1 feedback draft"). Only read the
    // native footer below the composer (❯, or › in newer builds), never
    // transcript prose. The expanded agent list can push that footer well
    // above the last 8 rows, so search the whole pane but require the composer.
    const composer = screen.findLastIndex( line => /^\s*[❯›]/.test( line ) )
    const controls = composer < 0 ? `` : screen.slice( composer + 1 ).join( `\n` )
    const counts = controls.match( /(?:^|[·•])\s*(\d+ [a-z]+(?:,\s*\d+ [a-z]+)*)\s*[·•]\s*← for agents\s*(?:[·•].*)?$/m )
    if( counts && /\b[1-9]\d* [a-z]+/.test( counts[ 1 ] ) ) return `waiting`

    // 2.1.30x drops the agents hint: "⏵⏵ bypass permissions on · 1 shell".
    // Without that anchor, only shell and monitor counts qualify.
    const bare = controls.match( /(?:^|[·•])\s*(\d+ (?:shells?|monitors?)(?:,\s*\d+ (?:shells?|monitors?))*)\s*(?:[·•].*)?$/m )
    if( bare && /\b[1-9]\d* [a-z]+/.test( bare[ 1 ] ) ) return `waiting`

    // Background subagents carry no count; each one gets a row under
    // "● main": "◯ general-purpose  Checking MTU   2m 59s · ↓ 35.6k tokens"
    if( /^\s*[○◯◉●]\s+(?!main\s*$)\S/m.test( controls ) ) return `waiting`
    if( /^\s*\?\s+for shortcuts\b/m.test( footer ) ) return `idle`
    return null

}

// Cleanup must identify a live control dialog, not words left in transcript.
// Match its native footer as well as its title, within the visible pane tail.
// Rows Claude cannot select drop the Enter/s hints and show only Esc.
// Compact panes can clip the cursor and footer. The native intro still
// identifies our dialog, so an error must not strand it on screen.
const owned_dialog = screen => {
    const tail = pane_tail( screen )
    const model = /(?:^|\n)\s*Select model\s*\n(?:\s*Switch between Claude models\.|[\s\S]*?Esc to cancel)/i
    const effort = /(?:^|\n)\s*Effort\s*\n[\s\S]*?←\/→ to adjust · Enter to confirm · s for this session only · Esc to cancel/i
    const cache = /(?:Change effort level\?|Switch model\?)[\s\S]*?Yes, switch to/i
    return model.test( tail ) || effort.test( tail ) || cache.test( tail )
}

// A person's draft belongs to them; only an empty composer (or Claude's own
// `Try "…"` suggestion) may take a slash command
const composer_draft = screen => {
    const composer_start = screen.lastIndexOf( `\n❯` )
    if( composer_start < 0 ) return `Claude's composer is not visible.`
    const composer_end = screen.indexOf( `\n──`, composer_start )
    if( composer_end < 0 ) return `Claude's composer border is not visible.`
    const composer = screen.slice( composer_start + 2, composer_end ).trim()
    if( composer && !/^Try "[^"]+"$/.test( composer ) ) return `Claude has a draft in its composer.`
    return null
}

// ── Native /model and /effort pickers ──

const selected_row = rows => rows.find( row => row.selected )?.number

const move_to = async ( rows, number, send_keys, capture, parse ) => {
    const start = selected_row( rows )
    if( start === undefined ) throw new Error( `Native picker did not show its selected row.` )
    const key = number < start ? `Up` : `Down`
    for( let step = 0; step < Math.abs( number - start ); step++ ) {
        await send_keys( key )
        const expected = start + Math.sign( number - start ) * ( step + 1 )
        await wait_for( capture, screen => selected_row( parse( screen ) ) === expected, 2_000 )
    }
    const updated = parse( await capture() )
    if( selected_row( updated ) !== number ) throw new Error( `Native picker moved unexpectedly; selection was not applied.` )
}

// Slash autocomplete can quote "Select model" inside a skill description
// before Claude handles Enter. Only a whole title line starts the live picker.
const claude_picker = screen => {
    const title = [ ...screen.matchAll( /^[ \t]*Select model[ \t]*$/gm ) ].at( -1 )
    return title ? screen.slice( title.index ) : ``
}

// Edge rows carry ↑/↓ scroll hints; the cursor replaces them when selected.
const claude_rows = screen => claude_picker( screen ).split( `\n` ).flatMap( line => {
    const match = line.match( /^\s*(❯)?\s*[↑↓]?\s*(\d+)\.\s+(.+?)\s*$/ )
    if( !match ) return []
    const [ , cursor, number, label ] = match
    const disabled = /\(disabled\)|Update Claude Code to use/i.test( label )
    return [ { number: Number( number ), label: label.trim(), selected: Boolean( cursor ), disabled } ]
} )

// Claude shows a scrolling window of model rows. Walk its own picker to get
// the full live catalog; Escape at the call site restores the original model.
// Newer pickers wrap at both ends, so one returning cycle already saw every row.
const scan_claude_models = async ( picker, capture, send_keys ) => {
    const seen = new Map()
    let screen = picker
    const remember = () => claude_rows( screen ).forEach( row => seen.set( row.number, row ) )
    remember()
    walk: for( const key of [ `Up`, `Down` ] ) {
        const visited = new Set( [ selected_row( claude_rows( screen ) ) ] )
        for( let step = 0; step < 30; step++ ) {
            const before = selected_row( claude_rows( screen ) )
            if( before === undefined ) throw new Error( `Claude model picker is clipped; enlarge the terminal and retry.` )
            await send_keys( key )
            try {
                screen = await wait_for( capture, next => selected_row( claude_rows( next ) ) !== before, 500 )
            } catch {
                screen = await capture()
                if( selected_row( claude_rows( screen ) ) === before ) break
            }
            const reached = selected_row( claude_rows( screen ) )
            if( reached === undefined ) throw new Error( `Claude model picker is clipped; enlarge the terminal and retry.` )
            remember()
            if( visited.has( reached ) ) break walk
            visited.add( reached )
        }
    }
    const current = selected_row( claude_rows( screen ) )
    return [ ...seen.values() ].sort( ( a, b ) => a.number - b.number )
        .map( row => ( { ...row, selected: row.number === current } ) )
}

const claude_alias = row => row.label.split( /\s{2,}/ )[ 0 ].replace( /\s*✔.*$/, `` ).trim()

// API IDs such as claude-opus-5-5 name the same row as the alias "Opus 5.5".
const claude_exact = ( row, value ) => {
    const alias = claude_alias( row )
    const needle = clean( value.replace( /-\d{8}$/, `` ) ).replace( /^claude/, `` )
    if( clean( alias ) === needle ) return true
    // Newer Claude catalogs put the version in the description of a family
    // alias. Default is not a versioned choice; context variants may be the
    // only row for that family when a long-context model is already active.
    if( !/^(?:opus|sonnet|haiku|fable)(?: \(1M context\))?$/i.test( alias ) ) return false
    const description = row.label.split( /\s{2,}/ )[ 1 ] || ``
    const versioned = description.match( /^([a-z]+ \d+(?:\.\d+)*)\b/i )?.[ 1 ]
    return versioned && clean( versioned ) === needle
}

const claude_match = ( row, value, target ) => {
    const alias = claude_alias( row )
    const needle = clean( value )
    if( needle === `default` && alias.startsWith( `Default` ) ) return true
    if( claude_exact( row, value ) ) return true
    if( [ target?.name, target?.displayName ].some( name => name && clean( name ) === needle && clean( name ) === clean( alias ) ) ) return true
    const family = needle.match( /(?:opus|sonnet|haiku|fable)/ )?.[ 0 ]
    if( family && /\[1m\]/i.test( value ) ) return clean( alias ).startsWith( family ) && /1m context/i.test( alias )
    return family && [ family, `claude${ family }` ].includes( needle ) && clean( alias ).startsWith( family )
}

const claude_model_entry = row => {
    const alias = claude_alias( row )
    const id = row.disabled ? null
        : /1m context/i.test( alias ) ? `${ alias.split( ` ` )[ 0 ].toLowerCase() }[1m]`
            : alias.startsWith( `Default` ) ? `default`
                : alias.toLowerCase().replace( /[^a-z0-9.]+/g, `-` ).replace( /-$/, `` )
    return { id, label: row.label, disabled: row.disabled, selected: row.selected }
}

const choose_claude_model = async ( value, target, rows, capture, send_keys ) => {
    const candidates = rows.map( ( row, index ) => ( { row, index } ) ).filter( ( { row } ) => claude_match( row, value, target ) )
    const enabled = candidates.filter( ( { row } ) => !row.disabled )
    const exact = candidates.filter( ( { row } ) => claude_exact( row, value ) )
    const exact_enabled = exact.filter( ( { row } ) => !row.disabled )
    if( exact.length && !exact_enabled.length ) throw unsupported( `${ claude_alias( exact[ 0 ].row ) } is unavailable in this Claude Code version.` )
    const standard = exact_enabled.filter( ( { row } ) => !/1m context/i.test( claude_alias( row ) ) )
    const matches = standard.length ? standard : exact_enabled.length ? exact_enabled : enabled
    if( matches.length !== 1 ) {
        const names = matches.map( ( { row } ) => claude_alias( row ) ).join( `, ` )
        throw unsupported( `Claude model '${ value }' is not uniquely available in the current picker.${ names ? ` Matches: ${ names }.` : `` }` )
    }
    const [ { row } ] = matches
    await move_to( claude_rows( await capture() ), row.number, send_keys, capture, claude_rows )
    const supports_effort = !/Effort not supported for/i.test( await capture() )
    await send_keys( `s` )
    return { selected: claude_alias( row ), supports_effort }
}

const effort_labels = screen => {
    const line = screen.split( `\n` ).find( text => /\blow\b/.test( text ) && /\bhigh\b/.test( text ) ) || ``
    return [ ...line.matchAll( /\b(low|medium|high|xhigh|max)\b/g ) ].map( match => match[ 1 ] )
}

// Moving to the left edge first avoids guessing which glyph a TUI uses for
// the selected stop. Every supported effort picker is a short bounded slider.
const choose_effort = async ( value, screen, send_keys, capture ) => {
    const levels = effort_labels( screen )
    if( !levels.length ) throw new Error( `Native effort picker did not expose supported levels.` )
    const index = levels.indexOf( value )
    if( index < 0 ) return { applied: null, supported: levels }
    for( let step = 0; step < levels.length; step++ ) await send_keys( `Left` )
    for( let step = 0; step < index; step++ ) await send_keys( `Right` )
    if( !effort_labels( await capture() ).includes( value ) ) throw new Error( `Effort picker changed unexpectedly.` )
    return { applied: value, supported: levels }
}

// The live dialog sits at the bottom; older transcript text must not trigger Enter.
const claude_cache_warning = screen => /(?:Change effort level\?|Switch model\?|full history gets re-read)/i.test( screen.split( `\n` ).slice( -20 ).join( `\n` ) )

// Idle Claude echoes "❯ /model" and its result into the transcript. Mid-turn
// it applies the change without an echo and shows only a transient
// right-aligned notice, so accept either. The full name keeps a lingering
// "Opus 5.5" notice from confirming a later "Opus 5".
const claude_confirmations = ( screen, operation, selected ) => {
    if( /(?:^|\n)\s*(?:Select model|Effort)\s*(?:\n|$)/i.test( screen ) || claude_cache_warning( screen ) ) return []
    const from = screen.lastIndexOf( `❯ /${ operation }` )
    const echoed = from < 0 ? `` : screen.slice( from )
    // Toasts sit directly above the composer. Long ones start at column two;
    // their indentation is not a reliable signal on a narrow terminal.
    const notices = screen.match( /(?:^|\n)[ \t]+((?:Set model to|Kept model as|Set effort level to)[^\n]*(?:\n[ \t]+(?![❯─⎿])\S[^\n]*)*)\n─[^\n]*\n❯/ )?.[ 1 ] || ``
    const actions = operation === `model` ? [ `Set model to`, `Kept model as` ] : [ `Set effort level to` ]
    const chosen = operation === `model` ? selected.replace( /\s*\(.*$/, `` ) : selected
    const named = new RegExp( `(?:^|[^\\w.])${ chosen.replace( /[.*+?^${}()|[\]\\]/g, `\\$&` ) }(?![\\w.])`, `i` )
    return [ echoed, notices ].flatMap( text => [ ...text.matchAll( /(?:Set model to|Kept model as|Set effort level to)[^\n]*(?:\n[ \t]+(?![❯─⎿])\S[^\n]*)*/g ) ] )
        .map( match => match[ 0 ].replace( /\s+/g, ` ` ).trim() )
        // Stop at the scope marker: later footer/progress text is not evidence
        // of a new selection, even if it redraws while an old notice remains.
        .map( notice => notice.match( /^.*?\bthis session only\b/ )?.[ 0 ] || notice )
        .filter( latest => actions.some( action => latest.startsWith( action ) )
            && ( latest.includes( `Kept model as` ) || latest.includes( `this session only` ) )
            && ( chosen === `Default` || named.test( latest ) ) )
        // A kept-model notice has no scope terminator. Compare its action,
        // not incidental footer/progress text collected by a wrapped capture.
        .map( notice => actions.find( action => notice.startsWith( action ) ) )
}

// Identical toasts can replace the same screen slot. Screen differences alone
// cannot distinguish that from a cancelled switch restoring an old notice.
// In that ambiguous case, reopen the native picker and read its initial value;
// never move it, and Escape restores the composer without changing settings.
const claude_readback = async ( { operation, selected, capture, send_text, send_keys, timeout_ms, reacquire } ) => {
    // The first picker has closed. A person may have started a draft or opened
    // a dialog meanwhile; reacquire permission to use the composer now.
    await reacquire()
    await send_text( `/${ operation }` )
    const picker = await wait_for( capture, screen => operation === `model`
        ? selected_row( claude_rows( screen ) ) !== undefined
        : /(?:^|\n)\s*Effort\s*(?:\n|$)/i.test( screen ) && effort_labels( screen ).length > 0, timeout_ms )
    let matches = false
    if( operation === `model` ) {
        const row = claude_rows( picker ).find( row => row.selected )
        matches = Boolean( row && clean( claude_alias( row ) ) === clean( selected ) )
    } else {
        // Transcript output can contain ▲ too (for example a build banner).
        // Only the live effort dialog can supply the current slider value.
        const title = [ ...picker.matchAll( /^[ \t]*Effort[ \t]*$/gim ) ].at( -1 )
        const lines = title ? picker.slice( title.index ).split( `\n` ) : []
        const slider = lines.findIndex( line => line.includes( `▲` ) )
        const cursor = lines[ slider ]?.indexOf( `▲` )
        const levels = [ ...( lines[ slider + 1 ] || `` ).matchAll( /\b(low|medium|high|xhigh|max)\b/g ) ]
        const current = levels.sort( ( first, second ) => Math.abs( first.index - cursor ) - Math.abs( second.index - cursor ) )[ 0 ]?.[ 0 ]
        matches = slider >= 0 && cursor >= 0 && current === selected
    }
    await send_keys( `Escape` )
    await wait_for( capture, screen => !/(?:^|\n)\s*(?:Select model|Effort)\s*(?:\n|$)/i.test( screen ), timeout_ms )
    return matches
}

const control = async ( { operation, value, target, capture, send_text, send_keys, timeout_ms, screen_before, reacquire } ) => {
    await send_text( `/${ operation }` )
    const ready = operation === `model`
        ? screen => selected_row( claude_rows( screen ) ) !== undefined
            || owned_dialog( screen ) && claude_rows( screen ).length > 0
        : screen => /(?:^|\n)\s*Effort\s*(?:\n|$)/i.test( screen )
    const picker = await wait_for( capture, ready, timeout_ms )

    const rows = operation === `model` ? await scan_claude_models( picker, capture, send_keys ) : []
    if( !value ) {
        const entries = operation === `model` ? rows.map( claude_model_entry ) : effort_labels( picker )
        await send_keys( `Escape` )
        const message = operation === `model` ? entries.map( row => `${ row.id || `unavailable` }  ${ row.label }` ).join( `\n` ) : entries.join( `, ` )
        return { message, models: operation === `model` ? entries : undefined, supported: operation === `effort` ? entries : undefined }
    }

    let selected
    let supports_effort = true
    if( operation === `model` ) ( { selected, supports_effort } = await choose_claude_model( value, target, rows, capture, send_keys ) )
    else {
        const choice = await choose_effort( value, picker, send_keys, capture )
        if( !choice.applied ) throw unsupported( `${ value } is unavailable for the current Claude model. Supported: ${ choice.supported.join( `, ` ) }.` )
        await send_keys( `s` )
        selected = value
    }

    let result = await wait_for( capture, screen => claude_cache_warning( screen ) || claude_confirmations( screen, operation, selected ).length, timeout_ms )
    if( claude_cache_warning( result ) ) {
        if( !/Yes, switch to/i.test( result ) ) throw new Error( `Claude opened an unexpected confirmation dialog.` )
        await send_keys( `Enter` )
        result = await wait_for( capture, screen => claude_confirmations( screen, operation, selected ).length, timeout_ms )
    }
    const before = claude_confirmations( screen_before, operation, selected )
    const after = claude_confirmations( result, operation, selected )
    const fresh = after.some( notice => !before.includes( notice ) )
    if( !fresh && !await claude_readback( { operation, selected, capture, send_text, send_keys, timeout_ms, reacquire } ) ) {
        throw new Error( `Claude did not confirm its new ${ operation }.` )
    }
    const old_effort = screen_before.match( /\b(low|medium|high|xhigh|max) · \/effort/i )?.[ 1 ]
    const new_effort = result.match( /\b(low|medium|high|xhigh|max) · \/effort/i )?.[ 1 ]
    if( operation === `model` && !supports_effort ) {
        // Claude hides effort on non-reasoning models but keeps the old value
        // internally. Reset that latent value to its native high default so
        // returning to a reasoning model does not resurrect an incompatible
        // max/xhigh choice. /effort still accepts session-only changes here.
        await control( { operation: `effort`, value: `high`, capture, send_text, send_keys, timeout_ms, screen_before: result, reacquire } )
        return { message: `Model set to ${ selected } for this Claude session. This model does not use effort; saved effort reset to high (default).`, applied: selected }
    }
    const effort_notice = operation === `model` && old_effort && new_effort && old_effort !== new_effort
        ? ` Effort changed from ${ old_effort } to ${ new_effort } for this model.` : ``
    return { message: `${ operation } set to ${ selected } for this Claude session.${ effort_notice }`, applied: selected }
}

export const claude_screen = {

    // Approval controls also say Escape, but await the user
    approval: /^\s*Esc to cancel\s*·\s*Tab to amend\b/i,
    activity,

    // Newer builds drop `? for shortcuts` under an idle composer, leaving only
    // the permission-mode footer: a pane that stays still under it is idle
    settle_footer: /\(shift\+tab to cycle\)/,

    // /model and /effort apply mid-turn, so a busy Claude still takes control
    control_while_busy: true,
    owned_dialog,
    composer_draft,
    control,

}
