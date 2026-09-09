import { existsSync } from 'fs'
import { hostname } from 'os'
import { randomUUID } from 'crypto'
import { wait } from 'mentie'
import { log } from '../utils/log.js'
import { TMUX_SOCKET } from '../utils/paths.js'
import { inspect_stored_sessions, load_session, session_workspace, update_session } from '../sessions/store.js'
import { acquire_session_lock, get_boot_id, lock_owner_is_stale } from '../sessions/lock.js'
import { docker_identity, recovery_candidates, select_recovery_sessions, session_lock_key, workspace_config_hash } from '../sessions/recovery.js'
import { verify_session_transcript, refresh_durable_identity, read_durable_exit } from '../sessions/transcript.js'
import { wait_for_continuation } from '../sessions/continuation.js'
import { list_sessions, get_session_pane, kill_session } from '../tmux/session.js'
import { inspect_docker_container_state, stop_docker_container } from '../docker/file_transport.js'
import { cmd_start, recover_clone_container, spawn_monitor_daemon } from './start.js'
import { merge_resume_flags } from './resume.js'
import { is_monitor_alive } from './monitor_process.js'

/** Explain why a durable launch cannot be automatically replayed. */
export const recovery_blocker = ( session, { replay = true } = {} ) => {

    if( session.recovery_version !== 1 ) return `Legacy session has no recovery intent; use babysit resume explicitly`
    if( !session.expected_open ) return `Intentionally closed`
    if( session.modifiers?.includes( `sandbox` ) ) return `Sandbox state is ephemeral`
    if( session.clone_pruned_at ) return `Clone workspace was pruned`
    if( session.host !== hostname() ) return `Session belongs to another host`
    if( session.tmux_socket && session.tmux_socket !== TMUX_SOCKET ) return `Use the original BABYSIT_TMUX_SOCKET=${ session.tmux_socket }`
    if( !session_workspace( session ) || !existsSync( session_workspace( session ) ) ) return `Workspace is unavailable`
    if( !replay ) return null
    if( session.clone_path && session.original_pwd && !existsSync( session.original_pwd ) ) return `Original clone source is unavailable; use babysit resume explicitly`
    if( !/^sha256:[a-f0-9]{64}$/.test( session.image_id || `` ) ) return `Immutable launch image was not recorded`
    if( !session.agent_session_id || session.agent_session_id_source !== `structured` ) return `Exact native conversation identity was not captured`
    if( session.launch_spec?.unsupported ) return `Launch contains unsupported replay arguments; use babysit resume explicitly`
    if( !session.launch_spec || session.launch_spec.config_hash !== workspace_config_hash( session_workspace( session ) ) ) return `Workspace configuration changed; use babysit resume explicitly`
    return null

}

const continuation_result = session => {

    if( [ `sent`, `skipped` ].includes( session?.continuation ) ) return null
    return session?.recovery_error || `Continuation ${ session?.continuation || `unavailable` }; inspect with babysit open (use --no-continue to acknowledge)`

}

/** Recover one launch while holding the same workspace lock as manual start/resume. */
export const recover_session = async ( record, flags = {}, {
    load = load_session,
    update = update_session,
    lock = acquire_session_lock,
    sessions = list_sessions,
    pane = get_session_pane,
    inspect = inspect_docker_container_state,
    monitor_alive = is_monitor_alive,
    spawn_monitor = spawn_monitor_daemon,
    reconcile = recover_clone_container,
    verify = verify_session_transcript,
    durable_identity = refresh_durable_identity,
    durable_exit = read_durable_exit,
    identity = docker_identity,
    start = cmd_start,
    wait_continuation = wait_for_continuation,
} = {} ) => {

    const release = lock( session_lock_key( record ) )
    const cwd = process.cwd()
    const old_image = process.env.BABYSIT_DOCKER_IMAGE
    const auth_environment = [ `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GEMINI_CLI_HOME`, `OPENCODE_CONFIG_DIR` ]
    const old_environment = Object.fromEntries( auth_environment.map( key => [ key, process.env[ key ] ] ) )
    try {
        const session = load( record.babysit_id )
        if( !session || session.superseded_by ) return { id: record.babysit_id, status: `skipped`, reason: `Superseded launch` }
        const blocked = recovery_blocker( session, { replay: false } )
        if( blocked ) return { id: session.babysit_id, status: `skipped`, reason: blocked }
        if( session.status === `preparing` && session.launch_owner && !lock_owner_is_stale( session.launch_owner ) ) {
            return { id: session.babysit_id, status: `preparing`, reason: `Launch is still in progress` }
        }

        const owner = await identity()
        if( owner.docker_id !== session.docker_id ) throw new Error( `Docker daemon differs from the original launch` )
        const active = ( await sessions( { strict: true } ) ).some( live => live.name === session.tmux_session )
        const monitoring = monitor_alive( session.monitor_pid, session.monitor_token, { boot_id: session.boot_id } )
        if( active ) {
            const target = await pane( session.tmux_session )
            if( target.pane_id !== session.pane_id || session.boot_id !== get_boot_id() ) throw new Error( `Tmux launch identity differs from saved session` )
            if( await inspect( session.container_id ) !== `running` ) throw new Error( `Agent container is not running; inspect session before recovery` )
            if( flags.dry_run ) return { id: session.babysit_id, status: monitoring ? `active` : `repairable` }
            if( flags.no_continue && [ `pending`, `blocked`, `sending` ].includes( session.continuation ) ) {
                const acknowledged = update( session.babysit_id, current => monitoring && current.continuation === `sending`
                    ? null : { continuation: `skipped`, recovery_error: null } )
                if( !acknowledged ) return { id: session.babysit_id, status: `blocked`, reason: `Continuation submission is in flight; inspect the conversation before acknowledging` }
            }
            if( !monitoring ) {
                const token = randomUUID()
                update( session.babysit_id, { monitor_token: token, shutdown_boot_id: null } )
                const pid = await spawn_monitor( session.babysit_id, token )
                update( session.babysit_id, { monitor_pid: pid } )
            }
            const latest = load( session.babysit_id )
            const completed = latest.continuation === `pending` ? await wait_continuation( session.babysit_id ) : latest
            const reason = completed.continuation ? continuation_result( completed ) : null
            return { id: session.babysit_id, status: reason ? `blocked` : monitoring ? `active` : `repaired`, ... reason ? { reason } : {}  }
        }

        if( monitoring ) throw new Error( `Monitor is still finalizing this launch; retry shortly` )
        const receipt = await durable_exit( session )
        if( receipt?.exit_status === 0 && !receipt.interrupted && !( session.shutdown_boot_id && session.shutdown_boot_id === session.boot_id ) ) {
            if( !flags.dry_run ) {
                await reconcile( session )
                if( await inspect( session.container_id || session.container_name ) ) throw new Error( `Closed agent container retained for credential recovery` )
                update( session.babysit_id, { expected_open: false, close_reason: `agent_exit`, closed_at: receipt.exited_at } )
            }
            return { id: session.babysit_id, status: `closed`, reason: `Agent exited normally before its monitor recorded closure` }
        }
        const durable = await durable_identity( session )
        if( durable ) {
            session.agent_session_id = durable.session_id
            session.agent_session_id_source = `structured`
            if( !flags.dry_run ) update( session.babysit_id, {
                agent_session_id: durable.session_id,
                agent_session_id_source: `structured`,
            } )
        }
        const replay_blocker = recovery_blocker( session )
        if( replay_blocker ) return { id: session.babysit_id, status: `blocked`, reason: replay_blocker }
        if( session.continuation === `sending` && !flags.no_continue ) {
            return { id: session.babysit_id, status: `blocked`, reason: `Previous continuation delivery is uncertain; inspect history or acknowledge with --no-continue` }
        }
        await verify( session )
        if( flags.dry_run ) return { id: session.babysit_id, status: `recoverable` }

        auth_environment.forEach( key => {
            const value = session.launch_spec.environment?.[ key ]
            if( value ) process.env[ key ] = value
            else delete process.env[ key ]
        } )
        await reconcile( session )
        const reconciled = load( session.babysit_id )
        if( await inspect( session.container_id || session.container_name ) ) {
            throw new Error( `Previous container retained for credential recovery; inspect credentials before retrying` )
        }
        process.chdir( session_workspace( session ) )
        process.env.BABYSIT_DOCKER_IMAGE = session.image_id
        const resumed = await start( {
            verb: `resume`, agent: session.agent,
            session_id: session.agent_session_id,
            metadata_resolved: true, stored_session: reconciled,
            lifecycle_locked: true, container_reconciled: true,
            recovering: true, detached: true, no_continue: flags.no_continue,
            flags: { ...merge_resume_flags( session.modifiers, {}, session ), log: session.launch_spec.log ?? false },
            passthrough: session.launch_spec.args || [],
        } )
        if( !resumed ) throw new Error( `Recovery launch did not complete` )
        const completed = await wait_continuation( resumed.babysit_id )
        const reason = continuation_result( completed )
        return { id: session.babysit_id, recovered_id: resumed.babysit_id, status: reason ? `blocked` : `recovered`, ... reason ? { reason } : {}  }
    } finally {
        process.chdir( cwd )
        if( old_image === undefined ) delete process.env.BABYSIT_DOCKER_IMAGE
        else process.env.BABYSIT_DOCKER_IMAGE = old_image
        auth_environment.forEach( key => {
            if( old_environment[ key ] === undefined ) delete process.env[ key ]
            else process.env[ key ] = old_environment[ key ]
        } )
        release()
    }

}

/** Manual recovery and the bounded boot sweep use identical session policy. */
export const cmd_recover = async ( cmd, dependencies = {} ) => {

    const output = process.stdout.write
    if( cmd.flags?.json ) process.stdout.write = process.stderr.write.bind( process.stderr )
    try {
        const results = await recover_batch( cmd, dependencies )
        if( cmd.flags?.json ) output.call( process.stdout, `${ JSON.stringify( results ) }\n` )
        return results
    } finally {
        process.stdout.write = output
    }

}

async function recover_batch( cmd, { inspect = inspect_stored_sessions, recover = recover_session, load = load_session, wait_fn = wait } = {} ) {

    const flags = cmd.flags || {}
    const { records, invalid_files } = inspect()
    const selected = select_recovery_sessions( records.map( record => record.session ), cmd.session_id )
    if( cmd.session_id && !selected.length ) throw new Error( `No current session found: ${ cmd.session_id }` )
    const results = invalid_files.map( path => ( { id: path, status: `blocked`, reason: `Malformed session record` } ) )
    // Boot recovery must never fail its unit after starting successful children:
    // systemd would terminate the whole cgroup. Failures stay visible in the journal.
    const deadline = Date.now() + 25 * 60_000
    for( const session of selected ) {
        if( !cmd.session_id && session.expected_open === false ) continue
        try {
            if( Date.now() >= deadline ) throw new Error( `Boot recovery time budget exhausted; run babysit recover manually` )
            let result
            let candidate = session
            for( let attempt = 0; attempt < ( flags.boot ? 3 : 1 ); attempt++ ) {
                try {
                    result = await recover( candidate, flags )
                    break
                } catch ( error ) {
                    if( !flags.boot || attempt === 2 ) throw error
                    // Failed attempts retain a complete replay spec. Follow the
                    // durable chain rather than retrying the retired parent.
                    const seen = new Set()
                    while( !seen.has( candidate.babysit_id ) ) {
                        seen.add( candidate.babysit_id )
                        const current = load( candidate.babysit_id )
                        const next = current?.superseded_by && load( current.superseded_by )
                        if( !next ) break
                        candidate = next
                    }
                    await wait_fn( 5_000 * ( attempt + 1 ) )
                }
            }
            results.push( result )
        } catch ( error ) {
            results.push( { id: session.babysit_id, status: `blocked`, reason: error.message } )
        }
    }
    if( !flags.json && !results.length ) console.log( `No interrupted sessions to recover.` )
    else if( !flags.json ) results.forEach( result => console.log( `${ result.id }: ${ result.status }${ result.recovered_id ? ` → ${ result.recovered_id }` : `` }${ result.reason ? ` — ${ result.reason }` : `` }` ) )
    if( !flags.boot && results.some( result => result.status === `blocked` ) ) process.exitCode = 1
    return results

}

/** Persist intentional closure before touching processes; shutdown preserves open intent. */
export const close_session = async ( session, { shutdown = false } = {}, {
    load = load_session, update = update_session, lock = acquire_session_lock,
} = {} ) => {

    const release = lock( session_lock_key( session ) )
    try {
        const latest = load( session.babysit_id )
        if( !latest || latest.superseded_by ) throw new Error( `Session was superseded; close its current launch instead` )
        if( latest.host && latest.host !== hostname() ) throw new Error( `Session belongs to another host` )
        if( latest.status === `preparing` && latest.launch_owner && !lock_owner_is_stale( latest.launch_owner ) ) {
            if( !shutdown ) throw new Error( `Session launch is still in progress; retry close after startup` )
            // The launcher still owns preparation and credential cleanup. Mark
            // suspension now; systemd's signals stop its process tree afterward.
            update( latest.babysit_id, { shutdown_boot_id: get_boot_id() } )
            return
        }
        update( latest.babysit_id, shutdown
            ? { shutdown_boot_id: get_boot_id() }
            : { expected_open: false, close_reason: `user`, closed_at: new Date().toISOString() } )
        const owner = await docker_identity()
        if( latest.docker_id && owner.docker_id !== latest.docker_id ) throw new Error( `Docker daemon differs from saved launch` )
        const active = ( await list_sessions( { strict: true } ) ).some( live => live.name === latest.tmux_session )
        if( active ) {
            const pane = await get_session_pane( latest.tmux_session )
            if( latest.pane_id && pane.pane_id !== latest.pane_id ) throw new Error( `Tmux pane belongs to another launch` )
        }
        await stop_docker_container( latest.container_id || latest.container_name )
        if( active ) await kill_session( latest.tmux_session )
        if( !is_monitor_alive( latest.monitor_pid, latest.monitor_token, { boot_id: latest.boot_id } ) ) await recover_clone_container( load_session( latest.babysit_id ) )
    } finally {
        release()
    }

}

/** Close a selected session, or suspend this account's expected-open launches at shutdown. */
export const cmd_close = async cmd => {

    const session = load_session( cmd.session_id )
    if( !session ) throw new Error( `No stored session found: ${ cmd.session_id }` )
    await close_session( session )
    log.info( `Closed ${ session.babysit_id }; it will not be recovered.` )

}

/** Service stop hook marks every local launch before Docker begins teardown. */
export const cmd_recovery_shutdown = async () => {

    const { records } = inspect_stored_sessions()
    const sessions = recovery_candidates( records.map( record => record.session ) )
        .filter( session => session.expected_open && session.host === hostname() )
    sessions.forEach( session => update_session( session.babysit_id, { shutdown_boot_id: get_boot_id() } ) )
    await Promise.allSettled( sessions.map( session => close_session( session, { shutdown: true } ) ) )

}
