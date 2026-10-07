import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

import pkg from '../../package.json' with { type: 'json' }
import { BABYSIT_DIR } from '../utils/paths.js'
import { log } from '../utils/log.js'

const RELEASES_LATEST_API = `https://api.github.com/repos/actuallymentor/babysit/releases/latest`
const CACHE_PATH = join( BABYSIT_DIR, `latest-version.json` )
// One GitHub call per six hours, shared by every babysit process on the host.
export const VERSION_CHECK_TTL_MS = 6 * 60 * 60_000
const FETCH_TIMEOUT_MS = 3_000

/**
 * Compare dotted versions numerically: 1.10.0 is newer than 1.9.9.
 * @param {string} left - Version to test
 * @param {string} right - Version to compare against
 * @returns {boolean} True when left is newer than right
 */
export const is_newer_version = ( left, right ) => {

    const parts = version => String( version ).replace( /^v/, `` ).split( `.` ).map( Number )
    const [ a, b ] = [ parts( left ), parts( right ) ]
    if( [ ...a, ...b ].some( Number.isNaN ) ) return false

    for( let index = 0; index < Math.max( a.length, b.length ); index++ ) {
        const difference = ( a[index] ?? 0 ) - ( b[index] ?? 0 )
        if( difference ) return difference > 0
    }

    return false

}

const read_cache = path => {
    try {
        return JSON.parse( readFileSync( path, `utf8` ) )
    } catch {
        return null
    }
}

const write_cache = ( path, record ) => {
    try {
        mkdirSync( dirname( path ), { recursive: true } )
        writeFileSync( path, JSON.stringify( record ) )
    } catch ( error ) {
        log.debug( `Could not cache the latest babysit version: ${ error.message }` )
    }
}

/**
 * Fetch the newest release tag from GitHub, bounded so a slow network never
 * holds a listing hostage.
 * @param {Object} [options]
 * @param {Function} [options.fetch_fn] - fetch seam
 * @returns {Promise<string|null>} Version without its v prefix, or null
 */
export const fetch_latest_version = async ( { fetch_fn = fetch } = {} ) => {

    try {
        const response = await fetch_fn( RELEASES_LATEST_API, {
            headers: { accept: `application/vnd.github+json`, 'user-agent': `babysit-version-check` },
            signal: AbortSignal.timeout( FETCH_TIMEOUT_MS ),
        } )
        if( !response.ok ) return null
        const { tag_name } = await response.json()
        return typeof tag_name === `string` ? tag_name.replace( /^v/, `` ) : null
    } catch {
        return null
    }

}

/**
 * Report a newer release from the cache, refreshing it in the background when
 * stale. The first listing after the TTL stays silent; the next one tells.
 * @param {Object} [options]
 * @param {string} [options.current] - Installed version
 * @param {string} [options.cache_path] - Cache file
 * @param {Function} [options.fetch_latest] - Release fetcher seam
 * @param {number} [options.now] - Epoch milliseconds
 * @returns {{ latest: string|null, refresh: Promise<void>|null }} Newer version when one is known
 */
export const newer_version_available = ( {
    current = pkg.version,
    cache_path = CACHE_PATH,
    fetch_latest = fetch_latest_version,
    now = Date.now(),
} = {} ) => {

    const cache = read_cache( cache_path )
    const fresh = cache && Number.isFinite( cache.checked_at ) && now - cache.checked_at < VERSION_CHECK_TTL_MS

    // Record the attempt before it resolves so parallel listings do not all fetch.
    const refresh = fresh ? null : ( async () => {
        write_cache( cache_path, { ...cache, checked_at: now } )
        const latest = await fetch_latest()
        if( latest ) write_cache( cache_path, { latest, checked_at: now } )
    } )()

    const latest = cache?.latest
    return { latest: latest && is_newer_version( latest, current ) ? latest : null, refresh }

}
