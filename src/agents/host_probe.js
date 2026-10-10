import { spawn } from 'child_process'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, isAbsolute, join } from 'path'

import { strip_ansi } from '../babysit/matcher.js'
import { resolve_credential_file } from '../credentials/paths.js'
import { answered_ok, build_host_auth_prompt, is_authentication_failure, last_nonempty_line } from './auth.js'

/*
 * Host CLI probes: the user's own agent CLI and login, no container. Seconds
 * instead of a Docker create, so the scheduled checker can afford to ask
 * often. Detection only: a host success never vouches for the Docker image,
 * so it is never written into the launch cache.
 */

export const HOST_CLI_CHECK_TIMEOUT_MS = 120_000
export const HOST_CLI_KILL_GRACE_MS = 1_500

const detect_platform = () => process.platform === `darwin` ? `darwin` : `linux`

/**
 * Find an executable on PATH without spawning a shell.
 * @param {string} bin - Executable name
 * @param {Object} [env=process.env] - Environment holding PATH
 * @returns {string|null} Absolute path, or null when absent
 */
export const resolve_host_bin = ( bin, env = process.env ) => {

    const candidates = isAbsolute( bin )
        ? [ bin ]
        : ( env.PATH || `` ).split( delimiter ).filter( Boolean ).map( directory => join( directory, bin ) )

    return candidates.find( path => {
        try {
            accessSync( path, constants.X_OK )
            return true
        } catch {
            return false
        }
    } ) || null

}

/**
 * Locate the agent's credential file when a plain file is its only stored
 * login. Keychain and Secret Service logins return null: a lookup failing in
 * a scheduler context is not evidence of anything.
 * @param {Object} agent - Agent adapter
 * @param {Object} [options] - Platform seam
 * @returns {string|null} Absolute credential file path
 */
export const host_credential_file = ( agent, { platform = detect_platform() } = {} ) => {

    const config = agent?.credentials?.[ platform ]
    if( !config?.file || config.keychain_service || config.secret_service ) return null
    return resolve_credential_file( config.file )

}

/**
 * Read the agent's credential file.
 * @param {Object} agent - Agent adapter
 * @param {Object} [options] - Platform and reader seams
 * @returns {{ state: 'present'|'absent'|'unknown', text?: string }} File state; only ENOENT is absent
 */
export const read_host_credential = ( agent, { platform = detect_platform(), read_file = readFileSync } = {} ) => {

    const path = host_credential_file( agent, { platform } )
    if( !path ) return { state: `unknown` }

    try {
        return { state: `present`, text: read_file( path, `utf8` ) }
    } catch ( error ) {
        return { state: error.code === `ENOENT` ? `absent` : `unknown` }
    }

}

/**
 * Run one real prompt through the host-installed agent CLI.
 * @param {Object} agent - Agent adapter with auth_check.host_args
 * @param {Object} [options] - Prompt, cancellation, and process seams
 * @param {AbortSignal|null} [options.signal] - Yield signal; `{ code: 'skip' }` reports skipped
 * @returns {Promise<Object|null>} Auth result, or null when no host probe is possible
 */
export const run_host_cli_auth_check = async ( agent, {
    prompt = build_host_auth_prompt(),
    signal = null,
    env = process.env,
    timeout_ms = HOST_CLI_CHECK_TIMEOUT_MS,
    kill_grace_ms = HOST_CLI_KILL_GRACE_MS,
    spawn_fn = spawn,
    resolve_bin = resolve_host_bin,
} = {} ) => {

    const args = agent?.auth_check?.host_args?.( prompt, { env } )
    const bin = args && resolve_bin( agent.bin, env )
    if( !bin ) return null

    const result = ( status, extra = {} ) => ( { name: agent.name, status, authenticated: status === `authenticated`, probe: `host`, ...extra } )
    if( signal?.aborted ) return result( signal.reason?.code === `skip` ? `skipped` : `cancelled` )

    // A scratch cwd keeps project settings and instructions out of the probe
    const cwd = mkdtempSync( join( tmpdir(), `babysit-auth-` ) )

    return new Promise( resolve => {

        let stdout = ``
        let stderr = ``
        let stop_reason = null
        let kill_timer = null

        // Detached: the CLI leads its own process group, so a stop reaches
        // any helpers it started too
        const child = spawn_fn( bin, args, {
            cwd,
            env: { ...env, NO_COLOR: `1` },
            stdio: [ `ignore`, `pipe`, `pipe` ],
            detached: true,
        } )

        const signal_group = name => {
            try {
                process.kill( -child.pid, name )
            } catch {
                if( child.exitCode === null ) child.kill?.( name )
            }
        }

        const stop = reason => {
            if( stop_reason ) return
            stop_reason = reason
            signal_group( `SIGTERM` )
            kill_timer = setTimeout( () => signal_group( `SIGKILL` ), kill_grace_ms )
            kill_timer.unref?.()
        }

        const on_abort = () => stop( signal.reason?.code === `skip` ? `skipped` : `cancelled` )
        const deadline = setTimeout( () => stop( `timed out` ), timeout_ms )
        deadline.unref?.()
        signal?.addEventListener?.( `abort`, on_abort, { once: true } )

        const finish = outcome => {
            clearTimeout( deadline )
            clearTimeout( kill_timer )
            // The leader is gone; a helper that ignored SIGTERM or outlived
            // a normal exit must not linger on the host
            signal_group( `SIGKILL` )
            signal?.removeEventListener?.( `abort`, on_abort )
            rmSync( cwd, { recursive: true, force: true } )
            resolve( outcome )
        }

        child.stdout?.on( `data`, chunk => stdout += chunk )
        child.stderr?.on( `data`, chunk => stderr += chunk )
        child.on( `error`, error => finish( result( `failed`, { reason: error.message } ) ) )

        child.on( `close`, code => {

            if( stop_reason === `timed out` ) return finish( result( `failed`, { reason: `timed out` } ) )
            if( stop_reason ) return finish( result( stop_reason ) )

            const output = strip_ansi( stdout ).trim()
            const diagnostic = strip_ansi( `${ stderr }\n${ stdout }` ).trim()
            if( code === 0 && answered_ok( output ) ) return finish( result( `authenticated` ) )

            const status = is_authentication_failure( diagnostic, agent ) ? `unauthenticated` : `failed`
            finish( result( status, { reason: last_nonempty_line( diagnostic ) || `exited with code ${ code }` } ) )

        } )

    } )

}
