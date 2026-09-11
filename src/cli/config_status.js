import { existsSync } from 'node:fs'
import { run } from '../utils/exec.js'

/**
 * Inspect this account's recovery unit without starting it or requiring sudo.
 * Missing systemd access leaves runtime state unknown, even when a unit exists.
 * @param {Object} [options] - Platform, account and read-only probe dependencies
 * @returns {Promise<Object>} Unit name, installation evidence and raw service states
 */
export const read_recovery_status = async ( {
    platform = process.platform,
    uid = process.getuid?.(),
    execute = run,
    exists = existsSync,
} = {} ) => {

    const unit = `babysit-recover-${ uid }.service`
    if( platform !== `linux` ) return { unit, installed: null, enabled: `not supported`, active: `not supported` }

    const installed = exists( `/etc/systemd/system/${ unit }` ) ? true : null
    const unavailable = { unit, installed, enabled: `unknown`, active: `unknown` }
    if( !exists( `/run/systemd/system` ) ) return unavailable

    try {
        const output = await execute( `/usr/bin/systemctl`, [
            `show`, unit, `--all`, `--property=LoadState,UnitFileState,ActiveState`, `--no-pager`,
        ], {}, 3000 )
        const fields = Object.fromEntries( output.split( `\n` ).filter( line => line.includes( `=` ) ).map( line => {
            const separator = line.indexOf( `=` )
            return [ line.slice( 0, separator ), line.slice( separator + 1 ) ]
        } ) )
        const missing = fields.LoadState === `not-found`
        return {
            unit,
            installed: missing ? false : fields.LoadState ? true : installed,
            enabled: fields.UnitFileState || ( missing ? `not installed` : `unknown` ),
            active: fields.ActiveState || `unknown`,
        }
    } catch {
        // A missing bus, denied request or timeout cannot establish absence.
        return unavailable
    }

}
