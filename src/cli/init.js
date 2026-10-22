import { createInterface } from 'readline/promises'
import { stdin, stdout } from 'process'

import { log } from '../utils/log.js'
import { write_default_config } from '../babysit/yaml.js'
import { command_to_launch, default_launch } from '../babysit/launch_config.js'
import { read_launch_defaults } from '../babysit/launch_defaults.js'
import { launch_menu } from './launcher.js'

const DEFAULT_FILE = `babysit.yaml`

/**
 * Ask which file to write when none was given on the command line.
 * Non-interactive runs take the default silently.
 * @returns {Promise<string>} File name
 */
const ask_file_name = async () => {

    if( !stdin.isTTY || !stdout.isTTY ) return DEFAULT_FILE
    const prompt = createInterface( { input: stdin, output: stdout } )
    try {
        const answer = ( await prompt.question( `Config file name [${ DEFAULT_FILE }]: ` ) ).trim()
        return answer || DEFAULT_FILE
    } finally {
        prompt.close()
    }

}

/**
 * Pick the `launch:` section through the launch menu, as if starting a
 * session. Non-interactive runs take the remembered menu defaults.
 * @returns {Promise<Object|null>} Launch section, or null when cancelled
 */
const choose_launch = async () => {

    if( !stdin.isTTY || !stdout.isTTY ) {
        const { agent, mode, docker, devices, yolo, clone, loop } = read_launch_defaults()
        return default_launch( { agent, mode, docker, devices, yolo, clone, loop } )
    }

    const chosen = await launch_menu( { submit: `save` } )
    return chosen && command_to_launch( chosen )

}

/**
 * `babysit init [file.yaml]`: write the commented default config, with the
 * launch section chosen in the launch menu. A file other than babysit.yaml is
 * used through `--config <file>`, or `--config <dir>` alongside others.
 * @param {Object} cmd - Parsed command { session_id: optional file name }
 * @param {Object} [deps]
 */
export const cmd_init = async ( cmd, {
    ask = ask_file_name,
    choose = choose_launch,
    write = write_default_config,
    cwd = process.cwd(),
    print = message => log.info( message ),
} = {} ) => {

    const file = cmd.session_id || await ask()
    if( !/\.ya?ml$/i.test( file ) ) throw new Error( `Config file name must end in .yaml or .yml: ${ file }` )

    const launch = await choose()
    if( !launch ) return print( `Cancelled; nothing written.` )

    const path = write( cwd, { file, launch } )
    print( `Wrote ${ path }` )
    if( file !== DEFAULT_FILE ) print( `Use it with: babysit --config ${ file }` )

}
