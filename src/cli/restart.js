import { close_session, select_stored_session, use_launch_environment } from './recover.js'
import { order_active_sessions } from './list.js'
import { cmd_resume } from './resume.js'
import { agent_activity } from '../babysit/activity.js'
import { capture_pane } from '../tmux/capture.js'
import { list_sessions } from '../tmux/session.js'
import { inspect_stored_sessions, load_session } from '../sessions/store.js'
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
 * Stored sessions behind every live, unarchived tmux session, in list order.
 * @param {Object} [options] - Injectable seams
 * @returns {Promise<Object[]>}
 */
export const unarchived_sessions = async ( { inspect_records = inspect_stored_sessions, sessions = list_sessions } = {} ) => {

    const stored = inspect_records().records.map( record => record.session )
    return order_active_sessions( await sessions( { strict: true } ), stored )
        .map( tmux => stored.find( session => session.tmux_session === tmux.name ) )
        .filter( session => session && !session.archived_at )

}

/**
 * Close and resume one stored session on the current image.
 * @param {Object} session - Stored session
 * @param {Object} flags - { force, detach, account, continue_prompt }
 * @param {Object} [options] - Injectable seams
 */
const restart_session = async ( session, { force = false, detach = false, account = false, continue_prompt = false }, {
    capture = capture_pane,
    activity = agent_activity,
    close = close_session,
    resume = cmd_resume,
    image_id = local_image_id,
    launch_environment = use_launch_environment,
    print = console.log,
} = {} ) => {

    // Checked before the close: a refused --account after it would strand the session
    if( account && session.agent !== `claude` ) throw new Error( `--account picks a Claude subscription; ${ session.babysit_id } is a ${ session.agent } session` )

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
            // --account switches the Claude subscription; --continue nudges the agent once it is back
            flags: { ...account && { account }, ...continue_prompt && { continue_prompt } },
            passthrough: session.launch_spec?.args || [], detached: detach,
        } ).catch( error => {
            // Past the close the session is down; say so, and how to get it back
            throw Object.assign( new Error( `${ session.babysit_id } closed but did not resume (${ error.message }); run babysit resume ${ session.babysit_id }` ), { closed: true } )
        } )
    } finally {
        restore_environment()
    }

    print( `Restarted ${ session.babysit_id } on ${ image_note }.` )

}

/**
 * Restart a running session on the current image without losing the
 * conversation: close it gracefully (monitor stops, credentials flush back to
 * the host, container removed), then resume it by its native agent id.
 * The agent must show an idle or waiting control; `--force` overrides.
 * `all` restarts every unarchived session detached, skipping refusals.
 * @param {Object} cmd - Parsed command { session_id, flags: { force, detach } }
 * @param {Object} [options] - Injectable seams
 */
export const cmd_restart = async ( cmd, { select = select_stored_session, select_all = unarchived_sessions, load = load_session, ...seams } = {} ) => {

    const flags = cmd.flags || {}
    if( cmd.session_id !== `all` ) return restart_session( await select( cmd.session_id ), flags, seams )

    const sessions = await select_all()
    const print = seams.print || console.log
    if( !sessions.length ) return print( `No unarchived sessions to restart.` )

    // One refusal (busy, sandbox) must not strand the rest, but a failed
    // resume might be the image, so stop before closing more sessions.
    // Attaching to many sessions makes no sense: the batch is always detached.
    const failed = []
    for( const session of sessions ) {
        try {
            // Reload: earlier restarts take minutes and stuck flags move meanwhile
            await restart_session( load( session.babysit_id ) || session, { ...flags, detach: true }, seams )
        } catch ( error ) {
            if( error.closed ) throw error
            failed.push( session.babysit_id )
            print( `Skipped ${ session.babysit_id }: ${ error.message }` )
        }
    }

    if( failed.length ) throw new Error( `${ failed.length } of ${ sessions.length } sessions not restarted: ${ failed.join( `, ` ) }` )

}
