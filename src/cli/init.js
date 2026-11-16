import { createInterface } from 'readline/promises'
import { stdin, stdout } from 'process'
import { existsSync } from 'fs'

import { write_default_config, write_global_config } from '../babysit/yaml.js'
import { GLOBAL_CONFIG_PATH } from '../utils/paths.js'
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
 * Y/n question, yes on Enter. Non-interactive runs answer no: an existing file
 * is never replaced without a person saying so.
 * @param {string} question - Prompt text, without the [Y/n] suffix
 * @returns {Promise<boolean>}
 */
const ask_yes = async question => {

    if( !stdin.isTTY || !stdout.isTTY ) return false
    const prompt = createInterface( { input: stdin, output: stdout } )
    try {
        const answer = ( await prompt.question( `${ question } [Y/n] ` ) ).trim().toLowerCase()
        return answer === `` || answer === `y` || answer === `yes`
    } finally {
        prompt.close()
    }

}

/**
 * `babysit init --global`: write the commented ~/.babysitrc.yaml. No launch
 * section: that stays per workspace. An existing file is replaced only on yes.
 * @param {Object} [deps]
 * @returns {Promise<void>}
 */
const init_global = async ( {
    path = GLOBAL_CONFIG_PATH,
    exists = existsSync,
    confirm = ask_yes,
    write = write_global_config,
    print = message => console.log( message ),
} = {} ) => {

    if( exists( path ) && !await confirm( `${ path } exists. Overwrite it with the defaults?` ) ) {
        return print( `Kept ${ path }; nothing written.` )
    }

    print( `Wrote ${ write( { path } ) }` )
    print( `It applies under every workspace babysit.yaml; uncomment a line to change it everywhere.` )

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
 * `--global` writes ~/.babysitrc.yaml instead (see init_global).
 * @param {Object} cmd - Parsed command { session_id: optional file name, flags.global }
 * @param {Object} [deps] - Seams; `global` holds init_global's
 */
export const cmd_init = async ( cmd, {
    ask = ask_file_name,
    choose = choose_launch,
    write = write_default_config,
    cwd = process.cwd(),
    print = message => console.log( message ),
    global = {},
} = {} ) => {

    if( cmd.flags?.global ) {
        if( cmd.session_id ) throw new Error( `babysit init --global always writes ${ GLOBAL_CONFIG_PATH }; drop the file name` )
        return init_global( { print, ...global } )
    }

    const file = cmd.session_id || await ask()
    if( !/\.ya?ml$/i.test( file ) ) throw new Error( `Config file name must end in .yaml or .yml: ${ file }` )

    const launch = await choose()
    if( !launch ) return print( `Cancelled; nothing written.` )

    const path = write( cwd, { file, launch } )
    print( `Wrote ${ path }` )
    if( file !== DEFAULT_FILE ) print( `Use it with: babysit --config ${ file }` )

}
