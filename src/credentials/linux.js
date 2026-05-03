import { readFileSync, writeFileSync, existsSync } from 'fs'
import { log } from '../utils/log.js'
import { run_sync } from '../utils/exec.js'
import { copy_host_file_to_tmpfile } from '../utils/tmpfile.js'
import { build_credential_sync_baseline, start_credential_sync } from './refresh.js'

/**
 * Set up credentials on Linux by copying credential files to tmpfiles
 * @param {Object} agent - Agent adapter
 * @param {Object} [options]
 * @param {string} [options.existing_tmpfile] - Re-use this tmpfile instead of creating a new
 *   one. Used by the monitor daemon, which must watch the SAME tmpfile the container is
 *   already mounting (created by the foreground). Without this, the monitor's sync would
 *   watch its own brand-new tmpfile and the container's OAuth refreshes would never make
 *   it back to the host file. See GOTCHAS.md.
 * @param {Object|null} [options.sync_baseline] - Foreground-capture hashes used by
 *   the monitor so pre-monitor tmpfile refreshes are not mistaken for stale host state
 * @returns {{ mounts: Array, sync: Object|null, sync_baseline: Object|null }} Credential mounts and sync controller
 */
export const setup_linux_credentials = async ( agent, { existing_tmpfile = null, sync_baseline = null } = {} ) => {

    const cred_config = agent.credentials?.linux
    if( !cred_config ) return { mounts: [], sync: null, sync_baseline: null }

    const mounts = []
    let sync = null
    let baseline = sync_baseline

    // File-based credentials (Claude, OpenCode, Codex OAuth, Gemini OAuth)
    if( cred_config.file ) {

        const expanded = cred_config.file.replace( `~`, process.env.HOME )

        if( existing_tmpfile || existsSync( expanded ) ) {

            let tmpfile = existing_tmpfile

            if( !tmpfile ) {

                // Pre-flight: invoke the agent CLI on the host so any near-expiry
                // token is refreshed before we copy. Without this, a stale token
                // would ride the container for 5 min before our sync daemon catches up.
                // Skipped when re-using an existing tmpfile — the foreground
                // already pre-flighted, and the container is already running on
                // that capture.
                run_sync( `${ agent.bin } --version 2>/dev/null` )

                // Copy host file into a chmod-666 tmpfile so the container's
                // `node` user can both read AND write it (agents like codex /
                // gemini refresh tokens in place). See utils/tmpfile.js for why
                // chmod is needed beyond writeFileSync's `mode` option.
                tmpfile = copy_host_file_to_tmpfile( expanded, `creds-${ agent.name }` )
                if( !tmpfile ) return { mounts, sync, sync_baseline: baseline }

                mounts.push( {
                    type: `volume`,
                    source: tmpfile,
                    target: agent.container_paths.creds,
                } )

                baseline = build_credential_sync_baseline( expanded, tmpfile )

            }

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

            sync = start_credential_sync( read_source, tmpfile, write_destination, baseline || {} )

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

    return { mounts, sync, sync_baseline: baseline }

}
