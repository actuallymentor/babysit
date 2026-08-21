import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const ROUTE_KEYS = [
    `provider`,
    `providers`,
    `model`,
    `small_model`,
    `enabled_providers`,
    `disabled_providers`,
]

const is_plain_object = value =>
    Boolean( value && typeof value === `object` && !Array.isArray( value ) )

const merge_config = ( base, override ) => Object.entries( override ).reduce(
    ( merged, [ key, value ] ) => ( {
        ...merged,
        [ key ]: is_plain_object( value ) && is_plain_object( merged[key] )
            ? merge_config( merged[key], value )
            : value,
    } ),
    { ...base }
)

const strip_jsonc_comments = input => {

    let output = ``
    let in_string = false
    let escaped = false
    let comment = null

    for( let index = 0; index < input.length; index++ ) {
        const character = input[index]
        const next = input[index + 1]

        if( comment === `line` ) {
            if( character === `\n` ) {
                comment = null
                output += character
            } else output += ` `
            continue
        }

        if( comment === `block` ) {
            if( character === `*` && next === `/` ) {
                output += `  `
                comment = null
                index++
            } else output += character === `\n` ? `\n` : ` `
            continue
        }

        if( !in_string && character === `/` && next === `/` ) {
            output += `  `
            comment = `line`
            index++
            continue
        }

        if( !in_string && character === `/` && next === `*` ) {
            output += `  `
            comment = `block`
            index++
            continue
        }

        output += character
        if( character === `"` && !escaped ) in_string = !in_string
        escaped = in_string && character === `\\` && !escaped
        if( character !== `\\` ) escaped = false
    }

    return output

}

const strip_trailing_commas = input => {

    let output = ``
    let in_string = false
    let escaped = false

    for( let index = 0; index < input.length; index++ ) {
        const character = input[index]

        if( character === `"` && !escaped ) in_string = !in_string
        if( !in_string && character === `,` ) {
            let next_index = index + 1
            while( /\s/.test( input[next_index] || `` ) ) next_index++
            if( [ `}`, `]` ].includes( input[next_index] ) ) continue
        }

        output += character
        escaped = in_string && character === `\\` && !escaped
        if( character !== `\\` ) escaped = false
    }

    return output

}

const parse_config = raw => {
    try {
        return JSON.parse( strip_trailing_commas( strip_jsonc_comments( raw ) ) )
    } catch {
        return {}
    }
}

const existing_config_path = ( directory, path_exists ) => [
    join( directory, `opencode.jsonc` ),
    join( directory, `opencode.json` ),
].find( path_exists ) || null

const route_only = config => Object.fromEntries(
    ROUTE_KEYS.filter( key => config[key] !== undefined ).map( key => [ key, config[key] ] )
)

/**
 * Resolve the safe provider/model subset used by OpenCode in the workspace.
 * Config sources follow OpenCode precedence; instructions, plugins, MCP, tools,
 * permissions, and user agents are deliberately omitted from the snapshot.
 *
 * @param {Object} [options]
 * @param {string} [options.workspace=process.cwd()] - Active project directory
 * @param {boolean} [options.include_host_preferences=true] - Include global/custom host config
 * @param {Object} [options.env=process.env] - Environment lookup
 * @param {string} [options.home_dir=homedir()] - Host home directory
 * @param {Function} [options.path_exists=existsSync] - Filesystem seam
 * @param {Function} [options.read_file=readFileSync] - File reader seam
 * @returns {Object} Sanitized merged route config
 */
export const resolve_opencode_route_config = ( {
    workspace = process.cwd(),
    include_host_preferences = true,
    env = process.env,
    home_dir = homedir(),
    path_exists = existsSync,
    read_file = path => readFileSync( path, `utf8` ),
} = {} ) => {

    const global_config = existing_config_path(
        join( home_dir, `.config`, `opencode` ),
        path_exists
    )
    const custom_config = env.OPENCODE_CONFIG && path_exists( env.OPENCODE_CONFIG )
        ? env.OPENCODE_CONFIG
        : null
    const project_config = existing_config_path( workspace, path_exists )
    const project_directory_config = existing_config_path(
        join( workspace, `.opencode` ),
        path_exists
    )
    const custom_directory_config = env.OPENCODE_CONFIG_DIR
        ? existing_config_path( env.OPENCODE_CONFIG_DIR, path_exists )
        : null
    const file_paths = [
        ...include_host_preferences ? [ global_config, custom_config ] : [],
        project_config,
        project_directory_config,
        ...include_host_preferences ? [ custom_directory_config ] : [],
    ].filter( Boolean )
    const file_configs = file_paths.map( path => {
        try {
            return route_only( parse_config( read_file( path ) ) )
        } catch {
            return {}
        }
    } )
    const inline_config = include_host_preferences && env.OPENCODE_CONFIG_CONTENT
        ? route_only( parse_config( env.OPENCODE_CONFIG_CONTENT ) )
        : {}

    return [ ...file_configs, inline_config ].reduce( merge_config, {} )

}
