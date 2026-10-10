import { spawn } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { get_agent } from '../agents/index.js'
import { resolve_host_bin, run_host_cli_auth_check } from '../agents/host_probe.js'

/*
 * `claude setup-token` mints a one-year login that outranks /login and never
 * rotates, so sessions stop racing each other for one-use refresh tokens.
 * Babysit runs it, takes the pasted token, proves it with one host prompt, and
 * keeps it in ~/.babysitrc, which every host command and container sources.
 */

export const CLAUDE_TOKEN_ENV = `CLAUDE_CODE_OAUTH_TOKEN`
export const CLAUDE_TOKEN_PATTERN = /^sk-ant-oat\d+-[\w-]+$/

const EXPORT_LINE = new RegExp( `^\\s*(?:export\\s+)?${ CLAUDE_TOKEN_ENV }=` )
const COMMENT_LINE = /^# Claude setup-token from babysit auth init\b/

/**
 * Put `export KEY=value` into the rc, replacing an earlier assignment.
 * @param {string} token - Validated token
 * @param {Object} [options] - Path, clock, and fs seams
 * @returns {string} The rc path written
 */
export const save_claude_token = ( token, {
    path = join( homedir(), `.babysitrc` ),
    now = new Date(),
    read = file => existsSync( file ) ? readFileSync( file, `utf8` ) : ``,
    write = writeFileSync,
    chmod = chmodSync,
} = {} ) => {

    const expires = new Date( now.getTime() + 365 * 24 * 3600_000 ).toISOString().slice( 0, 10 )
    const kept = read( path ).split( `\n` ).filter( line => !EXPORT_LINE.test( line ) && !COMMENT_LINE.test( line ) )
    while( kept.length && !kept.at( -1 ).trim() ) kept.pop()

    const block = [
        `# Claude setup-token from babysit auth init, ${ now.toISOString().slice( 0, 10 ) }; expires ~${ expires }`,
        `export ${ CLAUDE_TOKEN_ENV }=${ token }`,
    ]
    write( path, `${ [ ...kept, ...kept.length ? [ `` ] : [], ...block ].join( `\n` ) }\n`, { mode: 0o600 } )
    chmod( path, 0o600 )
    return path

}

/**
 * Read a pasted token. Terminals may hard-wrap it, so lines are joined until
 * an empty line.
 * @param {Object} options - Streams
 * @returns {Promise<string>} Token with all whitespace removed
 */
export const read_pasted_token = ( { input, output } ) => new Promise( resolve => {

    const reader = createInterface( { input, terminal: false } )
    const parts = []
    output.write( `Paste the token printed above, then press Enter on an empty line:\n` )

    const done = () => {
        reader.close()
        resolve( parts.join( `` ).replace( /\s+/g, `` ) )
    }
    reader.on( `line`, line => line.trim() ? parts.push( line ) : done() )
    reader.on( `close`, () => resolve( parts.join( `` ).replace( /\s+/g, `` ) ) )

} )

const run_setup_token = bin => new Promise( resolve => {
    const child = spawn( bin, [ `setup-token` ], { stdio: `inherit` } )
    child.on( `error`, () => resolve( false ) )
    child.on( `exit`, code => resolve( code === 0 ) )
} )

const ask_yes = ( { input, output }, question ) => new Promise( resolve => {
    const reader = createInterface( { input, output } )
    reader.question( question, answer => {
        reader.close()
        resolve( !/^n(?:o)?$/i.test( answer.trim() ) )
    } )
} )

/**
 * The `babysit auth init` step for Claude's long-lived token.
 * @param {Object} cmd - Parsed command; `flags.claude_token` true forces, false skips
 * @param {Object} [options] - Streams, environment, and process seams
 * @returns {Promise<'saved'|'present'|'skipped'|'failed'>} Outcome
 */
export const setup_claude_token = async ( cmd, {
    input = process.stdin,
    output = process.stdout,
    env = process.env,
    resolve_bin = resolve_host_bin,
    setup = run_setup_token,
    paste = read_pasted_token,
    confirm = ask_yes,
    verify = token => run_host_cli_auth_check( get_agent( `claude` ), { env: { ...env, [ CLAUDE_TOKEN_ENV ]: token } } ),
    save = save_claude_token,
} = {} ) => {

    const wanted = cmd.flags?.claude_token
    if( wanted === false ) return `skipped`

    const bin = resolve_bin( `claude`, env )
    if( !bin ) return `skipped`

    if( env[ CLAUDE_TOKEN_ENV ] && wanted !== true ) {
        output.write( `Claude: sessions use ${ CLAUDE_TOKEN_ENV } (replace it: babysit auth init --claude-token).\n` )
        return `present`
    }

    if( !input.isTTY || !output.isTTY ) {
        output.write( `Claude: run babysit auth init --claude-token in a terminal to set up a one-year token that stops /login refresh races.\n` )
        return `skipped`
    }

    if( wanted !== true && !await confirm( { input, output }, `Set up a one-year Claude token so sessions stop logging each other out? [Y/n] ` ) ) {
        output.write( `Skipped. Later: babysit auth init --claude-token\n` )
        return `skipped`
    }

    if( !await setup( bin ) ) {
        output.write( `claude setup-token did not finish; nothing saved.\n` )
        return `failed`
    }

    const token = await paste( { input, output } )
    if( !CLAUDE_TOKEN_PATTERN.test( token ) ) {
        output.write( `That does not look like a setup-token (sk-ant-oat…); nothing saved.\n` )
        return `failed`
    }

    // One real prompt with the new token, so a bad paste never reaches sessions.
    // A relocated CLAUDE_CONFIG_DIR has no host probe; the token stands on its format.
    output.write( `Checking the token with one prompt…\n` )
    const result = await verify( token )
    if( result && !result.authenticated ) {
        output.write( `Claude rejected the token (${ result.reason || result.status }); nothing saved.\n` )
        return `failed`
    }

    const path = save( token )
    env[ CLAUDE_TOKEN_ENV ] = token
    output.write( `Saved ${ CLAUDE_TOKEN_ENV } to ${ path } (0600). New sessions use it; restart running Claude sessions to switch.\n` )
    return `saved`

}
