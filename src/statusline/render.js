import { writeFileSync, existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { log } from '../utils/log.js'

const __dirname = dirname( fileURLToPath( import.meta.url ) )

/**
 * Write the loop deadline file so the statusline can show countdown
 * @param {number|string} deadline - Unix epoch seconds or "idle"
 */
export const write_loop_deadline = ( deadline ) => {

    try {
        writeFileSync( `/tmp/babysit-loop-deadline`, String( deadline ) )
    } catch ( e ) {
        log.debug( `Failed to write loop deadline: ${ e.message }` )
    }

}

/**
 * Get the path to the embedded statusline.sh script
 * @returns {string}
 */
export const get_statusline_path = () => {

    return join( __dirname, `..`, `docker`, `assets`, `statusline.sh` )

}

/**
 * Patch Claude settings.json to use the babysit statusline
 * @param {string} settings_path - Path to the settings.json file
 * @param {string[]} modifiers - Active mode modifiers for display
 */
export const patch_claude_settings = ( settings_path, modifiers ) => {

    try {

        let settings = {}
        if( existsSync( settings_path ) ) {
            settings = JSON.parse( readFileSync( settings_path, `utf-8` ) )
        }

        settings.statusLine = {
            type: `command`,
            command: `bash /usr/local/bin/statusline.sh`,
        }

        writeFileSync( settings_path, JSON.stringify( settings, null, 2 ) )
        log.debug( `Patched Claude settings with statusline` )

    } catch ( e ) {
        log.debug( `Failed to patch settings: ${ e.message }` )
    }

}
