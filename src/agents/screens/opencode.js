/**
 * OpenCode screen knowledge: activity, owned dialogs, composer drafts and the
 * native /models picker. The shared loops live in src/babysit/activity.js
 * and src/control/terminal.js.
 */
import { clean, pane_tail, unsupported, wait_for } from '../../control/terminal_kit.js'

// Its idle footer, once the shared interrupt scan found nothing
const activity = ( { footer } ) => /^\s*tab\s+agents\s+ctrl\+p\s+commands\s*$/m.test( footer ) ? `idle` : null

// The model and variant pickers Babysit opens, by title and native footer
const owned_dialog = screen => {
    const tail = pane_tail( screen )
    return /Select model\s+esc[\s\S]*?Connect provider ctrl\+a/i.test( tail )
        || /(?:^|\n)\s*Select variant\s+esc\s*\n/i.test( tail )
}

// Only the empty `Ask anything` placeholder may take a slash command
const composer_draft = screen => {
    const composer = screen.match( /^\s*┃\n\s*┃\s{2}([^\n]+)\n\s*┃\n\s*┃\s{2}(?:Build|Plan) · /m )?.[ 1 ]?.trim()
    if( composer === undefined ) return `OpenCode's composer is not visible.`
    if( !composer.startsWith( `Ask anything` ) ) return `OpenCode has a draft in its composer.`
    return null
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

const control = async ( { operation, value, target, capture, send_text, send_keys, timeout_ms } ) => {
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

export const opencode_screen = {
    activity,
    owned_dialog,
    composer_draft,
    control,
}
