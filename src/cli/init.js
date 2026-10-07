import { createInterface } from 'readline/promises'
import { stdin, stdout } from 'process'

import { log } from '../utils/log.js'
import { write_default_config } from '../babysit/yaml.js'

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
 * `babysit init [file.yaml]`: write the commented default config.
 * A file other than babysit.yaml is used through `--config <file>`.
 * @param {Object} cmd - Parsed command { session_id: optional file name }
 * @param {Object} [deps]
 */
export const cmd_init = async ( cmd, {
    ask = ask_file_name,
    write = write_default_config,
    cwd = process.cwd(),
    print = message => log.info( message ),
} = {} ) => {

    const file = cmd.session_id || await ask()
    if( !/\.ya?ml$/i.test( file ) ) throw new Error( `Config file name must end in .yaml or .yml: ${ file }` )

    const path = write( cwd, { file } )
    print( `Wrote ${ path }` )
    if( file !== DEFAULT_FILE ) print( `Use it with: babysit <agent> --config ${ file }` )

}
