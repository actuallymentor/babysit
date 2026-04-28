import { readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { run_sync } from '../utils/exec.js'
import { log } from '../utils/log.js'
import { start_credential_sync } from './refresh.js'

/**
 * Extract credentials from macOS Keychain for an agent
 * @param {Object} agent - Agent adapter
 * @returns {{ mounts: Array, sync: Object|null }} Credential mounts and sync controller
 */
export const setup_darwin_credentials = async ( agent ) => {

    const cred_config = agent.credentials?.darwin
    if( !cred_config ) return { mounts: [], sync: null }

    const mounts = []
    let sync = null

    // Keychain-based credentials (e.g. Claude)
    if( cred_config.keychain_service ) {

        // Phase 1: detect without reading secrets
        const exists = run_sync(
            `security find-generic-password -s "${ cred_config.keychain_service }" 2>/dev/null`
        )

        if( exists !== null ) {

            // Phase 2: capture after pre-flight (caller handles pre-flight)
            const creds_json = run_sync(
                `security find-generic-password -s "${ cred_config.keychain_service }" -w 2>/dev/null`
            )

            if( creds_json ) {

                // Write to tmpfile
                const tmpfile = join( tmpdir(), `babysit-creds-${ agent.name }-${ Date.now() }` )
                writeFileSync( tmpfile, creds_json, { mode: 0o666 } )

                mounts.push( {
                    type: `volume`,
                    source: tmpfile,
                    target: agent.container_paths.creds,
                } )

                // Start background sync daemon
                const read_source = async () => run_sync(
                    `security find-generic-password -s "${ cred_config.keychain_service }" -w 2>/dev/null`
                )
                sync = start_credential_sync( read_source, tmpfile )

                log.info( `Credentials loaded from macOS Keychain (${ cred_config.keychain_service })` )

            }

        }

        // Fallback to file-based credential
        if( !mounts.length && cred_config.fallback_file ) {
            const expanded = cred_config.fallback_file.replace( `~`, process.env.HOME )
            if( existsSync( expanded ) ) {
                const tmpfile = join( tmpdir(), `babysit-creds-${ agent.name }-${ Date.now() }` )
                const content = readFileSync( expanded, `utf-8` )
                writeFileSync( tmpfile, content, { mode: 0o666 } )
                mounts.push( { type: `volume`, source: tmpfile, target: agent.container_paths.creds } )
                log.info( `Credentials loaded from file: ${ expanded }` )
            }
        }

    }

    // Environment variable based credentials (e.g. Codex, Gemini)
    if( cred_config.env_key && process.env[ cred_config.env_key ] ) {
        mounts.push( { type: `env`, key: cred_config.env_key, value: process.env[ cred_config.env_key ] } )
        log.info( `Credentials loaded from env: ${ cred_config.env_key }` )
    }

    if( cred_config.fallback_env && process.env[ cred_config.fallback_env ] && !mounts.length ) {
        mounts.push( { type: `env`, key: cred_config.env_key || cred_config.fallback_env, value: process.env[ cred_config.fallback_env ] } )
        log.info( `Credentials loaded from env fallback: ${ cred_config.fallback_env }` )
    }

    return { mounts, sync }

}
