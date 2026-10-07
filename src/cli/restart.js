import { close_session, select_stored_session } from './recover.js'
import { cmd_resume } from './resume.js'
import { observe_session_activity } from './list.js'
import { get_image_name } from '../docker/update.js'
import { docker_command_prefix } from '../docker/run.js'
import { run } from '../utils/exec.js'
import { log } from '../utils/log.js'

// Statuses that mean the agent is not mid-turn. `unknown` means the pane
// could not be read, which is not evidence of idleness.
const RESTARTABLE = new Set( [ `idle`, `waiting` ] )

/**
 * Id of the image a fresh launch would use, for the "updated or not" report.
 * @param {Object} [options]
 * @param {Function} [options.run_command] - Command runner seam
 * @returns {Promise<string|null>}
 */
export const local_image_id = async ( { run_command = run } = {} ) => {

    const [ command, ...prefix ] = docker_command_prefix()
    try {
        return String( await run_command( command, [ ...prefix, `image`, `inspect`, `--format`, `{{.Id}}`, get_image_name() ], {}, 15_000 ) ).trim() || null
    } catch {
        return null
    }

}

const short_id = id => String( id || `` ).replace( /^sha256:/, `` ).slice( 0, 12 ) || `unknown`

/**
 * Restart a running session on the current image without losing the
 * conversation: close it gracefully (monitor stops, credentials flush back to
 * the host, container removed), then resume it by its native agent id.
 * The agent must be between turns; `--force` overrides the pane check.
 * @param {Object} cmd - Parsed command { session_id, flags: { force, detach } }
 * @param {Object} [options] - Injectable seams
 */
export const cmd_restart = async ( cmd, {
    select = select_stored_session,
    observe = observe_session_activity,
    close = close_session,
    resume = cmd_resume,
    image_id = local_image_id,
    print = console.log,
} = {} ) => {

    const session = await select( cmd.session_id )
    const { force = false, detach = false } = cmd.flags || {}

    if( !force ) {
        const [ observed ] = await observe( [ { name: session.tmux_session } ], [ session ] )
        const status = session.stuck_at ? `stuck` : observed?.agent_status || `unknown`
        if( !RESTARTABLE.has( status ) ) {
            throw new Error( `Session ${ session.babysit_id } is ${ status }; restart it between turns, or pass --force.` )
        }
    }

    const next_image = await image_id()
    const updated = next_image && session.image_id && next_image !== session.image_id
    const image_note = next_image
        ? `image ${ short_id( next_image ) } (${ updated ? `updated from ${ short_id( session.image_id ) }` : `unchanged` })`
        : `image unknown`

    log.info( `Restarting ${ session.agent } session ${ session.babysit_id } on ${ image_note }` )
    await close( session )

    // Resume rebuilds the container with the stored config, credentials and
    // modifiers, and continues the agent by its native id when one was seen.
    await resume( { verb: `resume`, agent: null, session_id: session.babysit_id, flags: {}, passthrough: [], detached: detach } )
    print( `Restarted ${ session.babysit_id } on ${ image_note }.` )

}
