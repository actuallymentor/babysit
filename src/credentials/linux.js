import { readFileSync, writeFileSync, existsSync } from 'fs'
import { log } from '../utils/log.js'
import { run_sync } from '../utils/exec.js'
import { copy_host_file_to_tmpfile } from '../utils/tmpfile.js'
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

            // Copy host file into a chmod-666 tmpfile so the container's
            // `node` user can both read AND write it (agents like codex /
            // gemini refresh tokens in place). See utils/tmpfile.js for why
            // chmod is needed beyond writeFileSync's `mode` option.
            const tmpfile = copy_host_file_to_tmpfile( expanded, `creds-${ agent.name }` )
            if( !tmpfile ) return { mounts, sync }

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

            // Bidirectional sync: when the in-container agent refreshes its
            // OAuth token, the new state needs to flow back to the host file
            // — otherwise the next babysit session reads the now-invalidated
            // refresh_token and fails with "refresh token was already used".
            // We don't pass a mode here so the host file's existing perms
            // (typically 0o600) are preserved by writeFileSync.
            const write_destination = async ( content ) => {
                try {
                    writeFileSync( expanded, content )
                } catch ( e ) {
                    log.debug( `Failed to write back to host creds at ${ expanded }: ${ e.message }` )
                }
            }

            sync = start_credential_sync( read_source, tmpfile, write_destination )

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
