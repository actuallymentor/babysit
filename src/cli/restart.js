import { close_session, select_stored_session, use_launch_environment } from './recover.js'
import { cmd_resume } from './resume.js'
import { agent_activity } from '../babysit/activity.js'
import { capture_pane } from '../tmux/capture.js'
import { get_image_name } from '../docker/update.js'
import { docker_command_prefix } from '../docker/run.js'
import { run } from '../utils/exec.js'
import { log } from '../utils/log.js'

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

/**
 * Why a session cannot be restarted without losing something, or null.
 * @param {Object} session - Stored session
 * @returns {string|null}
 */
export const restart_blocker = session => {

    if( session.modifiers?.includes( `sandbox` ) ) return `Sandbox sessions keep their conversation only inside the container; restarting would discard it.`
    if( !session.agent_session_id ) return `No native ${ session.agent } session id was captured; resume would continue the workspace's latest conversation, which may be another one. Pass --force to accept that.`
    return null

}

const short_id = id => String( id || `` ).replace( /^sha256:/, `` ).slice( 0, 12 ) || `unknown`

/**
 * Restart a running session on the current image without losing the
 * conversation: close it gracefully (monitor stops, credentials flush back to
 * the host, container removed), then resume it by its native agent id.
 * The agent must show an idle or waiting control; `--force` overrides.
 * @param {Object} cmd - Parsed command { session_id, flags: { force, detach } }
 * @param {Object} [options] - Injectable seams
 */
export const cmd_restart = async ( cmd, {
    select = select_stored_session,
    capture = capture_pane,
    activity = agent_activity,
    close = close_session,
    resume = cmd_resume,
    image_id = local_image_id,
    launch_environment = use_launch_environment,
    print = console.log,
} = {} ) => {

    const session = await select( cmd.session_id )
    const { force = false, detach = false } = cmd.flags || {}

    // Sandbox loss is unconditional; the rest is the user's call with --force.
    const blocker = restart_blocker( session )
    if( blocker && ( !force || blocker.startsWith( `Sandbox` ) ) ) throw new Error( blocker )

    // Slow Docker work first, so the pane check sits right before the close.
    const next_image = await image_id()
    const updated = next_image && session.image_id && next_image !== session.image_id
    const image_note = next_image
        ? `image ${ short_id( next_image ) } (${ updated ? `updated from ${ short_id( session.image_id ) }` : `unchanged` })`
        : `image unknown`

    if( !force ) {
        // Only a recognised idle/waiting control counts. A quiet but unknown
        // screen (connecting, a dialog) is not evidence that no turn is running.
        const status = session.stuck_at ? `stuck` : activity( await capture( `=${ session.tmux_session }:` ), session.agent )
        if( ![ `idle`, `waiting` ].includes( status ) ) {
            throw new Error( `Session ${ session.babysit_id } shows ${ status || `no idle control` }; restart it between turns, or pass --force.` )
        }
    }

    log.info( `Restarting ${ session.agent } session ${ session.babysit_id } on ${ image_note }` )

    // Close and resume under the launch's own credential profile, with the
    // agent arguments it was started with, so nothing changes but the image.
    const restore_environment = launch_environment( session )
    try {
        await close( session )
        await resume( {
            verb: `resume`, agent: null, session_id: session.babysit_id,
            flags: {}, passthrough: session.launch_spec?.args || [], detached: detach,
        } )
    } finally {
        restore_environment()
    }

    print( `Restarted ${ session.babysit_id } on ${ image_note }.` )

}
