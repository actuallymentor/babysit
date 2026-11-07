import { existsSync, readFileSync, writeFileSync } from 'fs'

import { log } from '../utils/log.js'
import {
    build_private_tmpfile,
    copy_host_file_to_private_tmpfile,
    private_credential_tmpdir,
} from '../utils/tmpfile.js'
import { build_credential_sync_baseline, start_credential_sync } from './refresh.js'
import { credential_env_keys, credential_sources, resolve_credential_file } from './paths.js'
import { read_keychain_item } from './keychain.js'

/*
 * One credential setup routine for every adapter and platform. The adapter
 * declares ordered host sources per platform (`credentials.sources`); the
 * first that yields a login is staged into a private sync copy and kept in
 * sync with Docker. Flags replace per-agent branches:
 *
 *   file_required     the host file is the login: absence = logout, other read
 *                     errors and partial JSON retain recovery state, and the
 *                     file's directory is watched for re-logins (Codex)
 *
 * A keychain source is one-way (host → container): a locked desktop keyring
 * must never turn a staged secret into a host file write.
 */

const EMPTY = { mounts: [], sync: null, sync_baseline: null, cleanup_path: null }

/**
 * Sync a file source both ways: container refreshes flow back to the host
 * file, a host re-login flows into the container.
 * @returns {Object} Sync controller
 */
const start_file_sync = ( agent, path, tmpfile, baseline, state_path ) => {

    const required = agent.credentials?.file_required === true

    const read_source = async () => {
        try {
            return readFileSync( path, `utf-8` )
        } catch ( error ) {
            // Only an absent required file means logout. Other failures
            // must retain recovery state rather than discard tokens.
            if( required && error.code !== `ENOENT` ) throw error
            return null
        }
    }

    // Mode is omitted so the host file keeps its perms (typically 0600)
    const write_destination = async content => {
        try {
            writeFileSync( path, content )
        } catch ( error ) {
            log.debug( `Failed to write back to host creds at ${ path }: ${ error.message }` )
            throw error
        }
    }

    return start_credential_sync( read_source, tmpfile, write_destination, {
        ...baseline,
        state_path,
        source_path: required ? path : null,
    } )

}

/**
 * Stage one agent's host login and start its sync, or reattach the sync to a
 * foreground capture (monitor handoff: no new file, no new mount).
 * @param {Object} agent - Agent adapter
 * @param {Object} [options]
 * @param {'darwin'|'linux'} [options.platform] - Host platform
 * @param {string|null} [options.existing_tmpfile] - Foreground sync copy to reuse
 * @param {Object|null} [options.sync_baseline] - Foreground capture hashes (and source kind)
 * @param {string|null} [options.state_path] - Durable sync state; written once a sync starts
 * @param {Object} [options.env=process.env] - Environment holding API keys
 * @param {Function} [options.read_keychain=read_keychain_item] - Keychain reader seam
 * @returns {{ mounts: Array, sync: Object|null, sync_baseline: Object|null, cleanup_path: string|null }}
 */
export const setup_agent_credentials = ( agent, {
    platform,
    existing_tmpfile = null,
    sync_baseline = null,
    state_path = null,
    env = process.env,
    read_keychain = read_keychain_item,
} = {} ) => {

    const sources = credential_sources( agent, platform )
    const env_keys = credential_env_keys( agent )
    if( !sources.length && !env_keys.length ) return { ...EMPTY }

    const mounts = []
    let sync = null
    let baseline = sync_baseline
    let cleanup_path = private_credential_tmpdir( existing_tmpfile )

    // A reattaching monitor keeps the source the foreground captured from.
    // Legacy captures carry no kind, so they rerun detection.
    const pinned = existing_tmpfile ? baseline?.credential_source || null : null

    for( const source of sources ) {

        if( source.keychain ) {

            if( pinned && pinned !== `keyring` ) continue

            const item = pinned ? null : read_keychain( source )
            const present = item?.state === `present`

            // Fresh capture needs the item's content; a legacy reattach only
            // needs to know the item exists (locked still counts as existing)
            if( existing_tmpfile ? item && item.state === `missing` : !present ) continue

            let tmpfile = existing_tmpfile
            if( !tmpfile ) {
                const transport = build_private_tmpfile( `creds-${ agent.name }`, `auth`, item.text, { file_mode: 0o666 } )
                if( !transport ) {
                    log.warn( `Failed to materialise ${ agent.name } keychain creds to tmpfile` )
                    return { mounts, sync, sync_baseline: baseline, cleanup_path }
                }
                tmpfile = transport.file
                cleanup_path = transport.directory
                mounts.push( { type: `synced_file`, source: tmpfile, target: agent.container_paths.creds } )
            }

            sync = start_credential_sync( async () => read_keychain( source ).text || null, tmpfile, null, {
                ...baseline,
                state_path,
                credential_source: `keyring`,
            } )
            baseline = sync.baseline()
            log.info( `Credentials loaded from macOS Keychain (${ source.keychain })` )
            break

        }

        if( source.file ) {

            if( pinned === `keyring` ) continue

            const path = resolve_credential_file( source.file )
            if( !existing_tmpfile && !existsSync( path ) ) continue

            let tmpfile = existing_tmpfile
            if( !tmpfile ) {
                // A chmod-666 client-side sync file: Docker stages it before
                // start and later pulls refreshed credentials back here
                const transport = copy_host_file_to_private_tmpfile( path, agent.name )
                if( !transport ) return { mounts, sync, sync_baseline: baseline, cleanup_path }
                tmpfile = transport.file
                cleanup_path = transport.directory
                mounts.push( { type: `synced_file`, source: tmpfile, target: agent.container_paths.creds } )
                baseline = build_credential_sync_baseline( path, tmpfile )
            }

            sync = start_file_sync( agent, path, tmpfile, baseline, state_path )
            log.info( `Credentials loaded from file: ${ path }` )
            break

        }

    }

    // Environment logins stack on a file login: a key overrides it at runtime
    const [ env_key, fallback_env ] = [ agent.credentials?.env_key, agent.credentials?.fallback_env ]
    if( env_key && env[ env_key ] ) {
        mounts.push( { type: `env`, key: env_key, value: env[ env_key ] } )
        log.info( `Credentials loaded from env: ${ env_key }` )
    } else if( fallback_env && env[ fallback_env ] ) {
        mounts.push( { type: `env`, key: env_key || fallback_env, value: env[ fallback_env ] } )
        log.info( `Credentials loaded from env fallback: ${ fallback_env }` )
    }

    return { mounts, sync, sync_baseline: baseline, cleanup_path }

}
