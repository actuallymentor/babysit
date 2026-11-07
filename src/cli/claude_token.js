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
 * Babysit runs it (or takes a token minted elsewhere), proves it with one host
 * prompt when a host claude exists, and keeps it in ~/.babysitrc, which every
 * host command and container sources. Containers get it as their only Claude
 * subscription login (hot swap file, see claude_accounts.js).
 */

export const CLAUDE_TOKEN_ENV = `CLAUDE_CODE_OAUTH_TOKEN`
export const CLAUDE_TOKEN_PATTERN = /^sk-ant-oat\d+-[\w-]+$/

const MANAGED_COMMENT = /^# Claude setup-token from babysit auth init\b/
const MANAGED_EXPORT = new RegExp( `^export ${ CLAUDE_TOKEN_ENV }=\\S*$` )

/**
 * Append Babysit's managed `export` block to the rc, replacing only an earlier
 * managed block. A user's own assignment stays untouched (it may sit in a
 * conditional or share a line); ours comes last, so it wins when sourced.
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

    const lines = read( path ).split( `\n` )
    const kept = lines.filter( ( line, index ) => !MANAGED_COMMENT.test( line )
        && !( MANAGED_EXPORT.test( line ) && MANAGED_COMMENT.test( lines[ index - 1 ] || `` ) ) )
    while( kept.length && !kept.at( -1 ).trim() ) kept.pop()

    const day = date => date.toISOString().slice( 0, 10 )
    const block = [
        `# Claude setup-token from babysit auth init, ${ day( now ) }; expires ~${ day( new Date( now.getTime() + 365 * 24 * 3600_000 ) ) }`,
        `export ${ CLAUDE_TOKEN_ENV }=${ token }`,
    ]
    write( path, `${ [ ...kept, ...kept.length ? [ `` ] : [], ...block ].join( `\n` ) }\n`, { mode: 0o600 } )
    chmod( path, 0o600 )
    return path

}

// Claude prefers these over CLAUDE_CODE_OAUTH_TOKEN; with any of them set, the
// proof prompt would test that route instead of the pasted token. The config
// dir is dropped so the host probe always runs (the env token outranks /login).
const OUTRANKING_ENV = [ `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_PROFILE`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CONFIG_DIR` ]

/**
 * Environment that can only authenticate with the given token.
 * @param {Object} env - Base environment
 * @param {string} token - Pasted token
 * @returns {Object} Probe environment
 */
export const token_probe_env = ( env, token ) => {
    const isolated = { ...env, [ CLAUDE_TOKEN_ENV ]: token }
    OUTRANKING_ENV.forEach( key => delete isolated[ key ] )
    return isolated
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

/**
 * Read a whole piped token (`echo $TOKEN | babysit auth init --claude-token --token-stdin`).
 * @param {NodeJS.ReadableStream} input - Piped stdin
 * @returns {Promise<string>} Token with all whitespace removed
 */
export const read_token_stdin = async input => {
    const chunks = []
    for await ( const chunk of input ) chunks.push( String( chunk ) )
    return chunks.join( `` ).replace( /\s+/g, `` )
}

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
 * The `babysit auth init` step for Claude's long-lived token, the only Claude
 * subscription login Babysit stages into containers. With `flags.name`
 * (`--name work`) the token becomes a named account in the registry instead
 * of the ~/.babysitrc default. `--token-stdin` imports a piped token without a
 * TTY; without a host `claude`, the user pastes one minted on another machine.
 * The format is always checked; the proof prompt needs a host `claude`.
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
    read_stdin = read_token_stdin,
    confirm = ask_yes,
    verify = token => run_host_cli_auth_check( get_agent( `claude` ), { env: token_probe_env( env, token ) } ),
    save = save_claude_token,
    // Lazy: the registry module imports this one
    save_named = async ( name, token ) => ( await import( './claude_accounts.js' ) ).save_account( name, token ),
} = {} ) => {

    // `default` is the rc token, so `--name default` is the plain flow
    const account = cmd.flags?.name && cmd.flags.name !== `default` ? cmd.flags.name : null
    const from_stdin = Boolean( cmd.flags?.token_stdin )
    const wanted = account || from_stdin ? true : cmd.flags?.claude_token
    if( wanted === false ) return `skipped`

    const bin = resolve_bin( `claude`, env )

    // Nothing asked for and no host Claude: a Codex-only host needs no token
    if( !bin && wanted !== true ) {
        output.write( `Claude: no host claude CLI. To run Claude sessions, import a setup-token: babysit auth init --claude-token\n` )
        return `skipped`
    }

    if( env[ CLAUDE_TOKEN_ENV ] && wanted !== true ) {
        output.write( `Claude: sessions use ${ CLAUDE_TOKEN_ENV } (replace it: babysit auth init --claude-token).\n` )
        return `present`
    }

    let token

    if( from_stdin ) token = await read_stdin( input )
    else {

        if( !input.isTTY || !output.isTTY ) {
            output.write( `Claude: run babysit auth init --claude-token in a terminal, or pipe a token: echo "$TOKEN" | babysit auth init --claude-token --token-stdin\n` )
            return `skipped`
        }

        if( wanted !== true && !await confirm( { input, output }, `Set up a one-year Claude token so sessions stop logging each other out? [Y/n] ` ) ) {
            output.write( `Skipped. Later: babysit auth init --claude-token\n` )
            return `skipped`
        }

        // Without a host claude the token is minted elsewhere and pasted here
        if( !bin ) output.write( `No host claude CLI: run claude setup-token on any machine with Claude Code, then paste its token here.\n` )
        else if( !await setup( bin ) ) {
            output.write( `claude setup-token did not finish; nothing saved.\n` )
            return `failed`
        }

        token = await paste( { input, output } )

    }

    if( !CLAUDE_TOKEN_PATTERN.test( token ) ) {
        output.write( `That does not look like a setup-token (sk-ant-oat…); nothing saved.\n` )
        return `failed`
    }

    // One real prompt with the new token, so a bad paste never reaches sessions
    if( bin ) {
        output.write( `Checking the token with one prompt…\n` )
        const result = await verify( token )
        if( !result?.authenticated ) {
            output.write( `Could not prove the token (${ result?.reason || result?.status || `no host probe` }); nothing saved.\n` )
            return `failed`
        }
    } else {
        output.write( `No host claude CLI to prove the token with a prompt; saving after a format check only.\n` )
    }

    if( account ) {
        const path = await save_named( account, token )
        output.write( `Saved Claude account "${ account }" to ${ path } (0600). Launches pick the account with most headroom, or pass --account ${ account }.\n` )
        return `saved`
    }

    const path = save( token )
    env[ CLAUDE_TOKEN_ENV ] = token
    output.write( `Saved ${ CLAUDE_TOKEN_ENV } to ${ path } (0600). New sessions use it; restart running Claude sessions to switch.\n` )
    return `saved`

}

// Claude settings keys that select a non-subscription route on their own
const ROUTE_SETTINGS = [ `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport` ]

/**
 * Name the configured Claude route that outranks a setup-token: an API key,
 * Bedrock, Vertex or Foundry, set in the environment (the host sources
 * ~/.babysitrc, which containers source too) or in Claude's settings.json.
 * Such a route is the session's Claude login as is; no setup-token needed.
 * @param {Object} [options] - Environment and settings seams
 * @returns {string|null} The route's variable or settings key, null for none
 */
export const claude_api_route = ( {
    env = process.env,
    settings_path = join( env.CLAUDE_CONFIG_DIR || join( env.HOME || homedir(), `.claude` ), `settings.json` ),
    read = path => JSON.parse( readFileSync( path, `utf8` ) ),
} = {} ) => {

    const routes = OUTRANKING_ENV.filter( key => key !== `CLAUDE_CONFIG_DIR` )
    const from_env = routes.find( key => env[ key ] )
    if( from_env ) return from_env

    let settings = null
    try {
        settings = read( settings_path )
    } catch {
        return null
    }

    return routes.find( key => settings?.env?.[ key ] )
        || ROUTE_SETTINGS.find( key => settings?.[ key ] )
        || null

}
