import { readFileSync, writeFileSync } from 'fs'
import { run_sync } from '../utils/exec.js'
import { log } from '../utils/log.js'
import {
    build_private_tmpfile,
    copy_host_file_to_private_tmpfile,
    private_credential_tmpdir,
} from '../utils/tmpfile.js'
import { build_credential_sync_baseline, start_credential_sync } from './refresh.js'
import { resolve_credential_file } from './paths.js'
import { decode_keyring_secret, start_keyring_sync } from './keyring.js'

const CREDENTIAL_COMMAND_TIMEOUT_MS = 10_000

/**
 * Extract credentials from macOS Keychain (or file fallback) for an agent
 * @param {Object} agent - Agent adapter
 * @param {Object} [options]
 * @param {string} [options.existing_tmpfile] - Re-use this tmpfile instead of creating a new
 *   one. The monitor must watch the foreground's client-local sync copy so Docker API
 *   pulls reach the same credential baseline.
 * @param {Object|null} [options.sync_baseline] - Foreground-capture hashes used by
 *   the monitor so pre-monitor tmpfile refreshes are not mistaken for stale host state
 * @param {Function} [options.run_command=run_sync] - Host command runner
 * @returns {{ mounts: Array, sync: Object|null, sync_baseline: Object|null, cleanup_path: string|null }} Credential specs and sync controller
 */
export const setup_darwin_credentials = async ( agent, {
    existing_tmpfile = null,
    sync_baseline = null,
    run_command = run_sync,
} = {} ) => {

    const cred_config = agent.credentials?.darwin
    if( !cred_config ) return { mounts: [], sync: null, sync_baseline: null, cleanup_path: null }

    const mounts = []
    let sync = null
    let baseline = sync_baseline
    let cleanup_path = private_credential_tmpdir( existing_tmpfile )

    // Keychain-based credentials (e.g. Claude on macOS)
    if( cred_config.keychain_service ) {

        const keychain_selector = `-s "${ cred_config.keychain_service }"${ cred_config.keychain_account ? ` -a "${ cred_config.keychain_account }"` : `` }`
        const read_keychain = () => {
            const value = run_command(
                `security find-generic-password ${ keychain_selector } -w 2>/dev/null`,
                { timeout_ms: CREDENTIAL_COMMAND_TIMEOUT_MS }
            )
            return cred_config.keychain_encoding === `go-keyring` ? decode_keyring_secret( value ) : value
        }

        // Preserve the foreground source when reconnecting a monitor. Legacy
        // Claude captures lack source metadata, so retain their detection path.
        // Antigravity captures are new: an unmarked baseline is file-backed.
        const pinned_source = existing_tmpfile && ( baseline?.credential_source || cred_config.keychain_encoding === `go-keyring` )
        const exists = pinned_source ? null : run_command(
            `security find-generic-password ${ keychain_selector } 2>/dev/null`,
            { timeout_ms: CREDENTIAL_COMMAND_TIMEOUT_MS }
        )
        const use_keychain = pinned_source ? baseline?.credential_source === `keyring` : exists !== null

        if( use_keychain ) {

            let tmpfile = existing_tmpfile

            if( !tmpfile ) {

                // Pre-flight: invoke the agent CLI so any near-expiry token gets
                // refreshed by the agent itself before we capture. Without this,
                // a stale token would ride the container until our 5-minute sync
                // daemon catches up.
                if( agent.credential_preflight ) {
                    run_command( `${ agent.bin } --version 2>/dev/null`, {
                        timeout_ms: CREDENTIAL_COMMAND_TIMEOUT_MS,
                    } )
                }

                // Phase 2: capture after pre-flight rotation
                const creds_json = read_keychain()

                if( creds_json ) {

                    // Materialise the keychain blob into a chmod-666 tmpfile so
                    // the container's `node` user can both read AND write it.
                    const transport = build_private_tmpfile(
                        `creds-${ agent.name }`,
                        `auth`,
                        creds_json,
                        { file_mode: 0o666 }
                    )
                    if( !transport ) {
                        log.warn( `Failed to materialise ${ agent.name } keychain creds to tmpfile` )
                        return { mounts, sync, sync_baseline: baseline, cleanup_path }
                    }

                    tmpfile = transport.file
                    cleanup_path = transport.directory

                    mounts.push( {
                        type: `synced_file`,
                        source: tmpfile,
                        target: agent.container_paths.creds,
                    } )

                }

            }

            if( tmpfile ) {

                const read_source = async () => read_keychain()
                sync = start_keyring_sync( read_source, tmpfile, baseline )
                baseline = sync.baseline()

                log.info( `Credentials loaded from macOS Keychain (${ cred_config.keychain_service })` )

            }

        }

        // Keychain miss → fallback to a file path if the agent declared one
        if( !mounts.length && !sync && cred_config.fallback_file ) {
            const file_mount = stage_credential_file( agent, cred_config.fallback_file, existing_tmpfile, baseline )
            if( file_mount ) {
                const { mount, sync: file_sync, sync_baseline: file_baseline, cleanup_path: file_cleanup } = file_mount
                if( mount ) mounts.push( mount )
                sync = file_sync
                baseline = file_baseline
                cleanup_path = file_cleanup
            }
        }

    }

    // Standalone file-based credentials (e.g. opencode auth.json on darwin —
    // opencode does NOT use Keychain, it stores tokens in
    // ~/.local/share/opencode/auth.json on every platform).
    if( !mounts.length && !sync && cred_config.file ) {
        const file_mount = stage_credential_file( agent, cred_config.file, existing_tmpfile, baseline )
        if( file_mount ) {
            const { mount, sync: file_sync, sync_baseline: file_baseline, cleanup_path: file_cleanup } = file_mount
            if( mount ) mounts.push( mount )
            sync = file_sync
            baseline = file_baseline
            cleanup_path = file_cleanup
        }
    }

    // Environment variable credentials (e.g. CODEX_API_KEY, GEMINI_API_KEY).
    // These can stack with file-based creds — env vars are how users override
    // the file's contents at runtime.
    if( cred_config.env_key && process.env[ cred_config.env_key ] ) {
        mounts.push( { type: `env`, key: cred_config.env_key, value: process.env[ cred_config.env_key ] } )
        log.info( `Credentials loaded from env: ${ cred_config.env_key }` )
    }

    if( cred_config.fallback_env && process.env[ cred_config.fallback_env ]
        && !mounts.some( m => m.type === `env` ) ) {
        mounts.push( { type: `env`, key: cred_config.env_key || cred_config.fallback_env, value: process.env[ cred_config.fallback_env ] } )
        log.info( `Credentials loaded from env fallback: ${ cred_config.fallback_env }` )
    }

    return { mounts, sync, sync_baseline: baseline, cleanup_path }

}

/**
 * Copy a credential file to a tmpfile and start the in-place sync daemon
 * @param {Object} agent - Agent adapter (for naming + container_paths)
 * @param {string|Function} file_pattern - Path on host (may contain ~) or a resolver
 * @param {string} [existing_tmpfile] - Re-use this tmpfile (monitor case) instead of
 *   creating a new one. When provided, no mount is returned (the foreground already
 *   wired up the docker mount) — only the sync.
 * @param {Object|null} [sync_baseline] - Foreground-capture hashes for monitor handoff
 * @returns {{ mount: Object|null, sync: Object, sync_baseline: Object|null, cleanup_path: string|null } | null}
 */
const stage_credential_file = ( agent, file_pattern, existing_tmpfile = null, sync_baseline = null ) => {

    const expanded = resolve_credential_file( file_pattern )

    const transport = existing_tmpfile
        ? null
        : copy_host_file_to_private_tmpfile( expanded, agent.name )
    const tmpfile = existing_tmpfile || transport?.file
    if( !tmpfile ) return null

    const baseline = sync_baseline || build_credential_sync_baseline( expanded, tmpfile )

    const read_source = async () => {
        try {
            return readFileSync( expanded, `utf-8` )
        } catch {
            return null
        }
    }

    // Bidirectional sync: when the in-container agent refreshes its OAuth
    // token, the new state needs to flow back to the host file. Without this,
    // the next babysit session reads the now-invalidated refresh_token and
    // fails with "refresh token was already used". Mode is omitted so the
    // host file's existing perms (typically 0o600) are preserved by writeFileSync.
    const write_destination = async ( content ) => {
        try {
            writeFileSync( expanded, content )
        } catch ( e ) {
            log.debug( `Failed to write back to host creds at ${ expanded }: ${ e.message }` )
            throw e
        }
    }

    const sync = start_credential_sync( read_source, tmpfile, write_destination, baseline || {} )
    log.info( `Credentials loaded from file: ${ expanded }` )

    return {
        // No new mount when re-using an existing tmpfile — the container is
        // already running on it (the foreground built the docker command from
        // the same path). The monitor only needs the sync.
        mount: existing_tmpfile
            ? null
            : { type: `synced_file`, source: tmpfile, target: agent.container_paths.creds },
        sync,
        sync_baseline: baseline,
        cleanup_path: transport?.directory || private_credential_tmpdir( existing_tmpfile ),
    }

}
