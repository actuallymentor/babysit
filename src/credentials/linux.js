import { readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { log } from '../utils/log.js'
import { run_sync } from '../utils/exec.js'
import { start_credential_sync } from './refresh.js'

/**
 * Set up credentials on Linux by copying credential files to tmpfiles
 * @param {Object} agent - Agent adapter
 * @returns {{ mounts: Array, sync: Object|null }} Credential mounts and sync controller
 */
export const setup_linux_credentials = async ( agent ) => {

    const cred_config = agent.credentials?.linux
    if( !cred_config ) return { mounts: [], sync: null }

    const mounts = []
    let sync = null

    // File-based credentials (Claude, OpenCode, Codex OAuth, Gemini OAuth)
    if( cred_config.file ) {

        const expanded = cred_config.file.replace( `~`, process.env.HOME )

        if( existsSync( expanded ) ) {

            // Pre-flight: invoke the agent CLI on the host so any near-expiry
            // token is refreshed before we copy. Without this, a stale token
            // would ride the container for 5 min before our sync daemon catches up.
            run_sync( `${ agent.bin } --version 2>/dev/null` )

            const content = readFileSync( expanded, `utf-8` )
            const tmpfile = join( tmpdir(), `babysit-creds-${ agent.name }-${ Date.now() }` )
            writeFileSync( tmpfile, content, { mode: 0o666 } )

            mounts.push( {
                type: `volume`,
                source: tmpfile,
                target: agent.container_paths.creds,
            } )

            const read_source = async () => {
                try {
                    return readFileSync( expanded, `utf-8` )
                } catch {
                    return null
                }
            }
            sync = start_credential_sync( read_source, tmpfile )

            log.info( `Credentials loaded from file: ${ expanded }` )

        }

    }

    // Environment variable based credentials — additive to file-based creds so
    // a user can still override via env even when an OAuth file exists.
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
