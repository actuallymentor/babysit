import { readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { run_sync } from '../utils/exec.js'
import { log } from '../utils/log.js'
import { start_credential_sync } from './refresh.js'

/**
 * Extract credentials from macOS Keychain (or file fallback) for an agent
 * @param {Object} agent - Agent adapter
 * @returns {{ mounts: Array, sync: Object|null }} Credential mounts and sync controller
 */
export const setup_darwin_credentials = async ( agent ) => {

    const cred_config = agent.credentials?.darwin
    if( !cred_config ) return { mounts: [], sync: null }

    const mounts = []
    let sync = null

    // Keychain-based credentials (e.g. Claude on macOS)
    if( cred_config.keychain_service ) {

        // Phase 1: detect without reading secrets
        const exists = run_sync(
            `security find-generic-password -s "${ cred_config.keychain_service }" 2>/dev/null`
        )

        if( exists !== null ) {

            // Pre-flight: invoke the agent CLI so any near-expiry token gets
            // refreshed by the agent itself before we capture. Without this,
            // a stale token would ride the container until our 5-minute sync
            // daemon catches up.
            run_sync( `${ agent.bin } --version 2>/dev/null` )

            // Phase 2: capture after pre-flight rotation
            const creds_json = run_sync(
                `security find-generic-password -s "${ cred_config.keychain_service }" -w 2>/dev/null`
            )

            if( creds_json ) {

                const tmpfile = join( tmpdir(), `babysit-creds-${ agent.name }-${ Date.now() }` )
                writeFileSync( tmpfile, creds_json, { mode: 0o666 } )

                mounts.push( {
                    type: `volume`,
                    source: tmpfile,
                    target: agent.container_paths.creds,
                } )

                const read_source = async () => run_sync(
                    `security find-generic-password -s "${ cred_config.keychain_service }" -w 2>/dev/null`
                )
                sync = start_credential_sync( read_source, tmpfile )

                log.info( `Credentials loaded from macOS Keychain (${ cred_config.keychain_service })` )

            }

        }

        // Keychain miss → fallback to a file path if the agent declared one
        if( !mounts.length && cred_config.fallback_file ) {
            const file_mount = mount_credential_file( agent, cred_config.fallback_file )
            if( file_mount ) {
                mounts.push( file_mount.mount )
                sync = file_mount.sync
            }
        }

    }

    // Standalone file-based credentials (e.g. opencode auth.json on darwin —
    // opencode does NOT use Keychain, it stores tokens in
    // ~/.local/share/opencode/auth.json on every platform).
    if( !mounts.length && cred_config.file ) {
        const file_mount = mount_credential_file( agent, cred_config.file )
        if( file_mount ) {
            mounts.push( file_mount.mount )
            sync = file_mount.sync
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

    return { mounts, sync }

}

/**
 * Copy a credential file to a tmpfile and start the in-place sync daemon
 * @param {Object} agent - Agent adapter (for naming + container_paths)
 * @param {string} file_pattern - Path on host (may contain ~)
 * @returns {{ mount: Object, sync: Object } | null}
 */
const mount_credential_file = ( agent, file_pattern ) => {

    const expanded = file_pattern.replace( `~`, process.env.HOME )
    if( !existsSync( expanded ) ) return null

    const tmpfile = join( tmpdir(), `babysit-creds-${ agent.name }-${ Date.now() }` )
    const content = readFileSync( expanded, `utf-8` )
    writeFileSync( tmpfile, content, { mode: 0o666 } )

    const read_source = async () => {
        try {
            return readFileSync( expanded, `utf-8` )
        } catch {
            return null
        }
    }

    const sync = start_credential_sync( read_source, tmpfile )
    log.info( `Credentials loaded from file: ${ expanded }` )

    return {
        mount: { type: `volume`, source: tmpfile, target: agent.container_paths.creds },
        sync,
    }

}
