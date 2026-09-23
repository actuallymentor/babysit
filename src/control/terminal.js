import { setTimeout as wait } from 'node:timers/promises'

const POLL_MS = 100
const DEFAULT_TIMEOUT_MS = 8_000
const pending = message => Object.assign( new Error( message ), { code: `CONTROL_PENDING` } )
const unsupported = message => Object.assign( new Error( message ), { code: `CONTROL_UNSUPPORTED` } )
const clean = value => value.toLowerCase().replace( /[^a-z0-9]/g, `` )

// Cleanup must identify a live control dialog, not words left in transcript.
// Match its native footer as well as its title, within the visible pane tail.
const owned_dialog = ( agent, screen ) => {
    const tail = screen.split( `\n` ).slice( -35 ).join( `\n` )
    if( agent === `claude` ) {
        const model = /(?:^|\n)\s*Select model\s*\n[\s\S]*?Enter to set as default · s to use this session only · Esc to cancel/i
        const effort = /(?:^|\n)\s*Effort\s*\n[\s\S]*?←\/→ to adjust · Enter to confirm · s for this session only · Esc to cancel/i
        const cache = /(?:Change effort level\?|Switch model\?)[\s\S]*?Yes, switch to/i
        return model.test( tail ) || effort.test( tail ) || cache.test( tail )
    }
    if( agent === `opencode` ) {
        return /Select model\s+esc[\s\S]*?Connect provider ctrl\+a/i.test( tail )
            || /(?:^|\n)\s*Select variant\s+esc\s*\n/i.test( tail )
    }
    if( agent === `antigravity` ) {
        return /(?:Switch Model|Set Effort)\s*\n[\s\S]*?Keyboard:/i.test( tail )
    }
    return false
}

const wait_for = async ( capture, predicate, timeout_ms ) => {
    const deadline = Date.now() + timeout_ms
    while( Date.now() < deadline ) {
        const screen = await capture()
        if( predicate( screen ) ) return screen
        await wait( POLL_MS )
    }
    throw new Error( `Agent control timed out waiting for its native UI.` )
}

// An existing panel or a person's draft belongs to them. Never close it or
// type into it. The host retries CONTROL_PENDING after the screen is clear.
const ensure_safe = ( agent, screen, busy ) => {
    if( busy && agent !== `claude` ) throw pending( `Wait for ${ agent } to finish the active turn.` )
    const dialog = /(?:^|\n)\s*(?:Do you trust[^\n]*\?|Select login method|Set Effort|Switch Model|Select model(?:\s+esc)?|Select variant(?:\s+esc)?|Search:|Change effort level\?|Switch model\?)\s*(?:\n|$)/im.test( screen )
    if( dialog ) {
        throw pending( `An agent dialog is already open.` )
    }

    if( agent === `claude` ) {
        const composer_start = screen.lastIndexOf( `\n❯` )
        if( composer_start < 0 ) throw pending( `Claude's composer is not visible.` )
        const composer_end = screen.indexOf( `\n──`, composer_start )
        if( composer_end < 0 ) throw pending( `Claude's composer border is not visible.` )
        const composer = screen.slice( composer_start + 2, composer_end ).trim()
        if( composer && !/^Try "[^"]+"$/.test( composer ) ) throw pending( `Claude has a draft in its composer.` )
    }

    if( agent === `antigravity` ) {
        const prompt = [ ...screen.matchAll( /^>[ \t]*(.*)$/gm ) ].at( -1 )?.[ 1 ]?.trim()
        if( prompt === undefined ) throw pending( `Antigravity's composer is not visible.` )
        if( prompt ) throw pending( `Antigravity has a draft in its composer.` )
    }

    if( agent === `opencode` ) {
        const composer = screen.match( /^\s*┃\n\s*┃\s{2}([^\n]+)\n\s*┃\n\s*┃\s{2}(?:Build|Plan) · /m )?.[ 1 ]?.trim()
        if( composer === undefined ) throw pending( `OpenCode's composer is not visible.` )
        if( !composer.startsWith( `Ask anything` ) ) throw pending( `OpenCode has a draft in its composer.` )
    }
}

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

const claude_rows = screen => screen.slice( screen.lastIndexOf( `Select model` ) ).split( `\n` ).flatMap( line => {
    const match = line.match( /^\s*(❯)?\s*(\d+)\.\s+(.+?)\s*$/ )
    if( !match ) return []
    const [ , cursor, number, label ] = match
    return [ { number: Number( number ), label: label.trim(), selected: Boolean( cursor ), disabled: /\(disabled\)/i.test( label ) } ]
} )

// Claude renders only three model rows at a time. Walk its own picker to get
// the full live catalog; Escape at the call site restores the original model.
const scan_claude_models = async ( picker, capture, send_keys ) => {
    const seen = new Map()
    let screen = picker
    const remember = () => claude_rows( screen ).forEach( row => seen.set( row.number, row ) )
    remember()
    for( const key of [ `Up`, `Down` ] ) {
        for( let step = 0; step < 30; step++ ) {
            const before = selected_row( claude_rows( screen ) )
            if( before === undefined ) throw new Error( `Claude model picker lost its selected row.` )
            await send_keys( key )
            try {
                screen = await wait_for( capture, next => selected_row( claude_rows( next ) ) !== before, 500 )
            } catch {
                screen = await capture()
                if( selected_row( claude_rows( screen ) ) === before ) break
            }
            remember()
        }
    }
    const current = selected_row( claude_rows( screen ) )
    return [ ...seen.values() ].sort( ( a, b ) => a.number - b.number )
        .map( row => ( { ...row, selected: row.number === current } ) )
}

const claude_match = ( row, value, target ) => {
    const alias = row.label.split( /\s{2,}/ )[ 0 ].replace( /\s*✔.*$/, `` ).trim()
    const needle = clean( value )
    if( needle === `default` && alias.startsWith( `Default` ) ) return true
    if( clean( alias ) === needle ) return true
    if( [ target?.name, target?.displayName ].some( name => name && clean( name ) === needle && clean( name ) === clean( alias ) ) ) return true
    const family = needle.match( /(?:opus|sonnet|haiku|fable)/ )?.[ 0 ]
    if( family && /\[1m\]/i.test( value ) ) return clean( alias ).startsWith( family ) && /1m context/i.test( alias )
    return family && ( needle === family || needle.startsWith( `claude` ) ) && clean( alias ).startsWith( family )
}

const claude_model_entry = row => {
    const alias = row.label.split( /\s{2,}/ )[ 0 ].replace( /\s*✔.*$/, `` ).trim()
    const id = row.disabled ? null
        : /1m context/i.test( alias ) ? `${ alias.split( ` ` )[ 0 ].toLowerCase() }[1m]`
            : alias.startsWith( `Default` ) ? `default`
                : alias.toLowerCase().replace( /[^a-z0-9.]+/g, `-` ).replace( /-$/, `` )
    return { id, label: row.label, disabled: row.disabled, selected: row.selected }
}

const choose_claude_model = async ( value, target, rows, capture, send_keys ) => {
    const candidates = rows.map( ( row, index ) => ( { row, index } ) ).filter( ( { row } ) => claude_match( row, value, target ) )
    const enabled = candidates.filter( ( { row } ) => !row.disabled )
    const exact = enabled.filter( ( { row } ) => clean( row.label.split( /\s{2,}/ )[ 0 ] ) === clean( value ) )
    const matches = exact.length ? exact : enabled
    if( matches.length !== 1 ) throw unsupported( `Claude model '${ value }' is not uniquely available in the current picker.` )
    const [ { row } ] = matches
    if( row.disabled ) throw unsupported( `${ row.label } is disabled in this Claude Code version.` )
    await move_to( claude_rows( await capture() ), row.number, send_keys, capture, claude_rows )
    const supports_effort = !/Effort not supported for/i.test( await capture() )
    await send_keys( `s` )
    return { selected: row.label.split( /\s{2,}/ )[ 0 ].replace( /\s*✔.*$/, `` ).trim(), supports_effort }
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

const claude_cache_warning = screen => /(?:Change effort level\?|Switch model\?|full history gets re-read)/i.test( screen )
const claude_confirmation = ( screen, operation, selected ) => {
    if( /(?:^|\n)\s*(?:Select model|Effort)\s*(?:\n|$)/i.test( screen ) ) return false
    const from = screen.lastIndexOf( `❯ /${ operation }` )
    if( from < 0 ) return false
    const latest = screen.slice( from )
    const actions = operation === `model` ? [ `Set model to`, `Kept model as` ] : [ `Set effort level to` ]
    const chosen = operation === `model` ? selected.split( /[\s(]/ )[ 0 ] : selected
    const unchanged = latest.includes( `Kept model as` )
    return actions.some( action => latest.includes( action ) )
        && ( unchanged || latest.includes( `this session only` ) )
        && ( chosen === `Default` || latest.toLowerCase().includes( chosen.toLowerCase() ) )
}

const claude_control = async ( { operation, value, target, capture, send_text, send_keys, timeout_ms, screen_before } ) => {
    await send_text( `/${ operation }` )
    const title = operation === `model` ? /Select model/i : /(?:^|\n)\s*Effort\s*(?:\n|$)/i
    const picker = await wait_for( capture, screen => title.test( screen ), timeout_ms )

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

    let result = await wait_for( capture, screen => claude_cache_warning( screen ) || claude_confirmation( screen, operation, selected ), timeout_ms )
    if( claude_cache_warning( result ) ) {
        if( !/Yes, switch to/i.test( result ) ) throw new Error( `Claude opened an unexpected confirmation dialog.` )
        await send_keys( `Enter` )
        result = await wait_for( capture, screen => claude_confirmation( screen, operation, selected ), timeout_ms )
    }
    if( !claude_confirmation( result, operation, selected ) ) {
        throw new Error( `Claude did not confirm its new ${ operation }.` )
    }
    const old_effort = screen_before.match( /[○●]\s+(low|medium|high|xhigh|max) · \/effort/i )?.[ 1 ]
    const new_effort = result.match( /[○●]\s+(low|medium|high|xhigh|max) · \/effort/i )?.[ 1 ]
    if( operation === `model` && !supports_effort ) {
        // Claude hides effort on non-reasoning models but keeps the old value
        // internally. Reset that latent value to its native high default so
        // returning to a reasoning model does not resurrect an incompatible
        // max/xhigh choice. /effort still accepts session-only changes here.
        await claude_control( { operation: `effort`, value: `high`, capture, send_text, send_keys, timeout_ms, screen_before: result } )
        return { message: `Model set to ${ selected } for this Claude session. This model does not use effort; saved effort reset to high (default).`, applied: selected }
    }
    const effort_notice = operation === `model` && old_effort && new_effort && old_effort !== new_effort
        ? ` Effort changed from ${ old_effort } to ${ new_effort } for this model.` : ``
    return { message: `${ operation } set to ${ selected } for this Claude session.${ effort_notice }`, applied: selected }
}

const opencode_rows = screen => {
    const start = screen.indexOf( `Select model` )
    const end = screen.indexOf( `Connect provider`, start )
    const picker = start < 0 ? `` : screen.slice( start, end < 0 ? undefined : end )
    return picker.split( `\n` ).flatMap( line => {
        const columns = line.trim().split( /\s{2,}/ )
        if( columns.length !== 2 || /Select|Search|Recent|esc/i.test( columns[ 0 ] ) ) return []
        const selected = /^[●❯>]/.test( columns[ 0 ] )
        return [ { name: columns[ 0 ].replace( /^[●❯>]\s*/, `` ), provider: columns[ 1 ], selected } ]
    } )
}

const opencode_picker_search = ( screen, title, value ) => {
    const lines = screen.split( `\n` )
    const index = lines.findIndex( line => line.includes( title ) )
    return index >= 0 && lines.slice( index + 1 ).find( line => line.trim() )?.trim() === value
}

const opencode_footer_matches = ( screen, target, effort ) => {
    if( /Select (?:model|variant)\s+esc/i.test( screen ) ) return false
    const line = screen.split( `\n` ).find( item => item.includes( `Build ·` ) || item.includes( `Plan ·` ) ) || ``
    return line.includes( target.name ) && line.toLowerCase().includes( target.provider_id.toLowerCase() )
        && ( !effort || effort === `default` || line.includes( `· ${ effort }` ) )
}

const opencode_model_footer_matches = ( screen, target ) => {
    if( /Select (?:model|variant)\s+esc/i.test( screen ) ) return false
    const line = screen.split( `\n` ).find( item => item.includes( `Build ·` ) || item.includes( `Plan ·` ) ) || ``
    return line.includes( target.name ) && line.toLowerCase().includes( target.provider_id.toLowerCase() )
}

const opencode_control = async ( { operation, value, target, capture, send_text, send_keys, timeout_ms } ) => {
    if( operation !== `model` ) throw unsupported( `OpenCode effort uses its managed inference hook.` )
    if( !value ) throw unsupported( `OpenCode model listing comes from the active provider catalog.` )
    if( !target?.name ) throw new Error( `OpenCode model selection needs a resolved catalog target.` )

    await send_text( `/models` )
    await wait_for( capture, screen => /Select model\s+esc/i.test( screen ), timeout_ms )
    await send_keys( `-l`, target.name )
    const picker = await wait_for( capture, screen => opencode_picker_search( screen, `Select model`, target.name ), timeout_ms )
    const rows = opencode_rows( picker )
    const [ first ] = rows
    if( !first || first.name !== target.name || clean( first.provider ) !== clean( target.provider_id ) ) {
        throw unsupported( `OpenCode model '${ target.id }' was not the first exact picker result (${ first?.name || `none` } / ${ first?.provider || `none` }).` )
    }
    await send_keys( `Enter` )
    const { effort } = target
    const next = await wait_for( capture, screen => /Select variant\s+esc/i.test( screen ) || opencode_model_footer_matches( screen, target ), timeout_ms )
    if( /Select variant\s+esc/i.test( next ) ) {
        if( effort && effort !== `default` && target.efforts?.includes( effort ) ) {
            await send_keys( `-l`, effort )
            const filtered = await wait_for( capture, screen => opencode_picker_search( screen, `Select variant`, effort ), timeout_ms )
            const lines = filtered.split( `\n` ).map( line => line.trim() )
            const options = lines.filter( line => [ `Default`, ...target.efforts ].includes( line ) )
            if( options[ 0 ] !== effort ) throw new Error( `OpenCode variant '${ effort }' was not the first exact picker result.` )
            await send_keys( `Enter` )
        } else await send_keys( `Escape` )
    }
    const result = await wait_for( capture, screen => opencode_model_footer_matches( screen, target ), timeout_ms )
    if( !opencode_footer_matches( result, target, effort ) ) {
        throw unsupported( `OpenCode kept ${ target.name } but did not select its ${ effort } variant. Choose another model first, then retry.` )
    }
    return { message: `Model selected: ${ target.id }${ effort && effort !== `default` ? ` (${ effort })` : `` }. It applies to the next OpenCode request.${ target.notice ? ` ${ target.notice }` : `` }`, applied: target.id }
}

const antigravity_rows = screen => screen.split( `\n` ).flatMap( line => {
    const match = line.match( /^\s*(>)?\s*(Gemini|Claude)\s+(.+?)(?:\s+\(current\))?\s*$/ )
    if( !match ) return []
    return [ { name: `${ match[ 2 ] } ${ match[ 3 ] }`.trim().replace( /\s+\(current\)$/, `` ), selected: Boolean( match[ 1 ] ) } ]
} )

const antigravity_control = async ( { operation, value, target, capture, send_text, send_keys, timeout_ms } ) => {
    // The exact slug form is native in agy 1.2.9. The family picker can silently
    // choose a different effort when rapid arrow events arrive together.
    if( operation === `model` && value ) {
        if( !target?.name ) throw new Error( `Antigravity model selection needs a resolved catalog target.` )
        if( value !== target.id || !/^[a-zA-Z0-9_.:/[\]-]+$/.test( value ) ) throw new Error( `Antigravity model ID is not a safe catalog slug.` )
        const family = target.name.replace( /\s*\((?:Low|Medium|High)\)\s*$/, `` )
        const effort = target.effort || value.match( /-(low|medium|high)$/ )?.[ 1 ]
        await send_text( `/model ${ value }` )
        const result = await wait_for( capture, screen => screen.includes( `Model set to ${ target.name }` ), timeout_ms )
        const footer = result.split( `\n` ).find( line => line.includes( `? for shortcuts` ) ) || ``
        if( !footer.includes( family ) || effort && !footer.includes( `· ${ effort }` ) ) {
            throw new Error( `Antigravity model readback differed from ${ value }.` )
        }
        return { message: `Model selected: ${ value } for this Antigravity session.`, applied: value }
    }

    await send_text( `/${ operation }` )
    const title = operation === `model` ? /Switch Model\n/i : /Set Effort\n/i
    const picker = await wait_for( capture, screen => title.test( screen ), timeout_ms )

    if( !value ) {
        const entries = operation === `model` ? antigravity_rows( picker ).map( row => row.name ) : effort_labels( picker )
        await send_keys( `Escape` )
        return { message: entries.join( `\n` ), models: operation === `model` ? entries : undefined, supported: operation === `effort` ? entries : undefined }
    }

    if( operation === `effort` ) {
        const levels = effort_labels( picker )
        if( !levels.includes( value ) ) {
            throw unsupported( `${ value } is unavailable for this Antigravity model. Supported: ${ levels.join( `, ` ) }.` )
        }
        await send_keys( `Escape` )
        await wait_for( capture, screen => !/Set Effort\n/i.test( screen ), timeout_ms )
        await send_text( `/effort ${ value }` )
        await wait_for( capture, screen => screen.includes( `Effort set to ${ value }` ) && new RegExp( `· ${ value }\\b` ).test( screen ), timeout_ms )
        return { message: `Effort set to ${ value } for this Antigravity session.`, applied: value }
    }
}

/**
 * Drive one Babysit-owned native TUI control through its exact tmux pane.
 * The host serializes calls and retries CONTROL_PENDING until a safe screen.
 * A failed control never presses Escape on an unowned dialog.
 */
export const terminal_control = async ( {
    agent, operation, value, target, capture, send_text, send_keys,
    dismiss, busy = false, timeout_ms = DEFAULT_TIMEOUT_MS,
} ) => {
    if( ![ `model`, `effort` ].includes( operation ) ) throw new Error( `Unknown terminal control '${ operation }'.` )
    if( value !== undefined && !/^[\x20-\x7E]{1,160}$/.test( value ) ) throw new Error( `Control value contains unsupported characters.` )
    if( typeof capture !== `function` || typeof send_text !== `function` || typeof send_keys !== `function` ) throw new Error( `Terminal control needs capture, send_text and send_keys callbacks.` )
    const screen = await capture()
    ensure_safe( agent, screen, busy )
    let opened = false
    let escaped = false
    const tracked_send_text = async text => {
        await send_text( text )
        opened = true
        escaped = false
    }
    const tracked_send_keys = async ( ...keys ) => {
        await send_keys( ...keys )
        if( keys.includes( `Escape` ) ) escaped = true
    }
    const context = { operation, value, target, capture, send_text: tracked_send_text, send_keys: tracked_send_keys, timeout_ms, screen_before: screen }
    try {
        switch ( agent ) {
        case `claude`: return await claude_control( context )
        case `opencode`: return await opencode_control( context )
        case `antigravity`: return await antigravity_control( context )
        default: throw unsupported( `${ agent } does not have a native terminal controller.` )
        }
    } catch ( error ) {
        if( opened && !escaped ) {
            try {
                if( dismiss ) await dismiss( current => owned_dialog( agent, current ) )
                else if( owned_dialog( agent, await capture() ) ) await send_keys( `Escape` )
            } catch { /* Preserve the control error if the pane has closed. */ }
        }
        throw error
    }
}
