import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { constants } from 'node:os'
import { basename, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { connect_rpc } from './rpc.mjs'
import { observe_completions } from './codex-completion.mjs'

const COMMANDS = new Set( `agents exec e review login logout mcp plugin mcp-server app-server remote-control completion update doctor sandbox debug apply a resume queue archive delete migrate-rollouts unarchive fork cloud cloud-tasks exec-server features help app execpolicy responses-api-proxy stdio-to-uds`.split( ` ` ) )
const VALUE_FLAGS = new Set( [ `-c`, `--config`, `--enable`, `--disable`, `--remote`, `--remote-auth-token-env`, `-i`, `--image`, `-m`, `--model`, `--local-provider`, `-p`, `--profile`, `-s`, `--sandbox`, `-C`, `--cd`, `--add-dir`, `-a`, `--ask-for-approval` ] )
const CONFIG_FLAGS = { '-m': `model`, '--model': `model`, '-s': `sandbox_mode`, '--sandbox': `sandbox_mode`, '-a': `approval_policy`, '--ask-for-approval': `approval_policy` }
const OPENCODE_COMMANDS = new Set( `completion acp mcp attach run generate debug console providers auth agent upgrade uninstall serve web models stats export import github pr session plugin plug db help`.split( ` ` ) )
const OPENCODE_VALUES = new Set( [ `--log-level`, `--port`, `--hostname`, `--mdns-domain`, `--cors`, `-m`, `--model`, `-s`, `--session`, `--prompt`, `--agent`, `--replay-limit` ] )

/**
 * Separate server configuration from the original interactive arguments.
 * Noninteractive commands and user-owned remote endpoints retain their launch.
 * @param {string[]} args - Codex arguments without its executable
 * @returns {Object} Managed launch configuration or a passthrough reason
 */
export function codex_launch_plan( args ) {

    const overrides = []
    const explicit = []
    const add_dirs = []
    let command
    let cwd
    let profile
    let local_provider
    let oss = false
    let bypass = false
    let strict_config = false

    for( let index = 0; index < args.length; index++ ) {
        const token = args[ index ]
        if( token === `--` ) break

        const equal = token.indexOf( `=` )
        const attached_short = /^-[cmpsCaip].+/.test( token )
        const flag = attached_short ? token.slice( 0, 2 ) : equal > 0 ? token.slice( 0, equal ) : token
        const value = attached_short ? token.slice( 2 ).replace( /^=/, `` ) : equal > 0 ? token.slice( equal + 1 ) : VALUE_FLAGS.has( flag ) ? args[ ++index ] : undefined

        if( [ `--help`, `-h`, `--version`, `-V` ].includes( flag ) ) return { managed: false }
        if( [ `--remote`, `--remote-auth-token-env` ].includes( flag ) ) return { managed: false }
        if( !token.startsWith( `-` ) && !command ) command = token
        if( [ `-p`, `--profile` ].includes( flag ) ) profile = value
        if( [ `-C`, `--cd` ].includes( flag ) ) cwd = resolve( value )
        if( [ `-c`, `--config` ].includes( flag ) ) overrides.push( `-c`, value )
        if( flag === `--enable` || flag === `--disable` ) overrides.push( `-c`, `features.${ value }=${ flag === `--enable` }` )
        if( CONFIG_FLAGS[ flag ] ) explicit.push( `-c`, `${ CONFIG_FLAGS[ flag ] }=${ JSON.stringify( value ) }` )
        if( flag === `--add-dir` ) add_dirs.push( resolve( value ) )
        if( flag === `--search` ) explicit.push( `-c`, `web_search="live"` )
        if( flag === `--strict-config` ) strict_config = true
        if( flag === `--local-provider` ) local_provider = value
        if( flag === `--oss` ) oss = true
        if( [ `--yolo`, `--dangerously-bypass-approvals-and-sandbox` ].includes( flag ) ) bypass = true
        if( flag === `--full-auto` ) explicit.push( `-c`, `approval_policy="on-request"`, `-c`, `sandbox_mode="workspace-write"` )
        if( flag === `--approve-for-me` ) explicit.push( `-c`, `approvals_reviewer="auto_review"`, `-c`, `approval_policy="on-request"`, `-c`, `sandbox_mode="workspace-write"` )
    }

    if( COMMANDS.has( command ) && ![ `resume`, `fork` ].includes( command ) ) return { managed: false }
    // Codex 0.153.4 rejects app-server --profile. Preserve profile behavior
    // instead of silently starting its server with another configuration.
    if( profile ) return { managed: false, warning: `Codex profiles do not support managed effort in this CLI version; using the original launch.` }
    if( oss && !local_provider ) return { managed: false, warning: `Select --local-provider to enable managed effort with --oss; using the original launch.` }
    if( local_provider ) explicit.push( `-c`, `model_provider=${ JSON.stringify( local_provider ) }` )
    if( add_dirs.length ) explicit.push( `-c`, `sandbox_workspace_write.writable_roots=${ JSON.stringify( add_dirs ) }` )
    if( bypass ) explicit.push( `-c`, `approval_policy="never"`, `-c`, `sandbox_mode="danger-full-access"` )

    return {
        managed: true,
        cwd,
        server_args: [ `app-server`, ...overrides, ...explicit, `-c`, `features.step_model_switching=true`, ... strict_config ? [ `--strict-config` ] : []  ],
    }

}

/**
 * Expose OpenCode's existing TUI server locally and add the inference hook.
 * @param {string[]} args - Original OpenCode arguments
 * @param {Object} env - Original environment, including optional inline config
 * @returns {Object} Managed plan or passthrough; pure mode remains plugin-free
 */
export function opencode_launch_plan( args, env = process.env ) {

    const tui_args = []
    let command
    let port = 0
    let pure = /^(1|true)$/i.test( env.OPENCODE_PURE || `` )

    for( let index = 0; index < args.length; index++ ) {
        const token = args[ index ]
        if( token === `--` ) {
            tui_args.push( ...args.slice( index ) ); break
        }
        const equal = token.indexOf( `=` )
        const flag = equal > 0 ? token.slice( 0, equal ) : token
        const value = equal > 0 ? token.slice( equal + 1 ) : OPENCODE_VALUES.has( flag ) ? args[ ++index ] : undefined

        if( [ `--help`, `-h`, `--version`, `-v` ].includes( flag ) ) return { managed: false }
        if( !token.startsWith( `-` ) && !command ) command = token
        if( flag === `--pure` ) pure = value !== `false`
        if( flag === `--no-pure` ) pure = false
        if( flag === `--port` ) {
            port = Number( value ); continue
        }
        if( flag === `--hostname` ) {
            if( ![ `127.0.0.1`, `localhost` ].includes( value ) ) return { managed: false, warning: `Managed effort requires a loopback OpenCode server; using the original launch.` }
            continue
        }
        if( [ `--mdns`, `--no-mdns` ].includes( flag ) ) {
            if( equal < 0 && [ `true`, `false` ].includes( args[ index + 1 ] ) ) index++
            continue
        }
        tui_args.push( token )
        if( equal < 0 && OPENCODE_VALUES.has( flag ) ) tui_args.push( value )
    }

    if( OPENCODE_COMMANDS.has( command ) ) return { managed: false }
    if( pure ) return { managed: false, warning: `OpenCode --pure disables the effort plugin; using the original launch.` }
    if( !Number.isInteger( port ) || port < 0 || port > 65_535 ) throw new Error( `Invalid OpenCode server port.` )

    const config = JSON.parse( env.OPENCODE_CONFIG_CONTENT || `{}` )
    if( !config || typeof config !== `object` || Array.isArray( config ) ||  config.plugin && !Array.isArray( config.plugin )  ) throw new Error( `OpenCode inline configuration must be an object with a plugin array.` )
    const plugin = new URL( `./opencode-plugin.mjs`, import.meta.url ).href
    config.plugin = [ ...( config.plugin || [] ).filter( existing => existing !== plugin ), plugin ]

    return { managed: true, port, tui_args, config_content: JSON.stringify( config ) }

}

const free_port = () => new Promise( ( resolve_port, reject ) => {
    const socket = createServer()
    socket.once( `error`, reject )
    socket.listen( 0, `127.0.0.1`, () => {
        const { port } = socket.address()
        socket.close( error => error ? reject( error ) : resolve_port( port ) )
    } )
} )

const child_process = ( executable, args, options ) => {
    const child = spawn( executable, args, options )
    child.managed_group = options.detached
    child.done = new Promise( resolve_child => {
        child.once( `error`, error => resolve_child( { error } ) )
        child.once( `close`, ( code, signal ) => resolve_child( { code, signal } ) )
    } )
    return child
}

// Tool shells may create their own process groups. Capture descendants before
// stopping the server so reparenting cannot leave an executing tool behind.
const descendants = root_pids => {
    const parents = new Map()
    for( const entry of readdirSync( `/proc` ) ) {
        if( !/^\d+$/.test( entry ) ) continue
        try {
            const stat = readFileSync( `/proc/${ entry }/stat`, `utf8` )
            parents.set( Number( entry ), Number( stat.slice( stat.lastIndexOf( `)` ) + 2 ).split( ` ` )[ 1 ] ) )
        } catch { /* A process can exit between directory listing and read. */ }
    }
    const result = new Set( root_pids.filter( Boolean ) )
    let changed = true
    while( changed ) {
        changed = false
        for( const [ pid, parent ] of parents ) if( result.has( parent ) && !result.has( pid ) ) {
            result.add( pid )
            changed = true
        }
    }
    return [ ...result ].reverse()
}

const signal_pid = ( pid, signal ) => {
    try {
        process.kill( pid, signal )
    } catch ( error ) {
        if( error.code !== `ESRCH` ) throw error
    }
}

const stop_children = async children => {
    if( !children.length ) return
    const pids = descendants( children.map( child => child.pid ) )
    const groups = children.filter( child => child.managed_group && child.pid ).map( child => -child.pid )
    groups.forEach( pid => signal_pid( pid, `SIGTERM` ) )
    pids.forEach( pid => signal_pid( pid, `SIGTERM` ) )
    const done = Promise.all( children.map( child => child.done ) )
    await Promise.race( [ done, delay( 2_000, undefined, { ref: false } ) ] )
    // Kill the saved descendants even when the parent exited before its tools.
    groups.forEach( pid => signal_pid( pid, `SIGKILL` ) )
    pids.forEach( pid => signal_pid( pid, `SIGKILL` ) )
    await Promise.race( [ done, delay( 1_000, undefined, { ref: false } ) ] )
}

const wait_for_server = async ( server, endpoint ) => {
    const deadline = Date.now() + 15_000
    let last_error
    while( Date.now() < deadline ) {
        if( server.exitCode !== null || server.signalCode ) throw new Error( `Codex app server exited before becoming ready.` )
        try {
            const rpc = await connect_rpc( endpoint, { timeout_ms: 500 } )
            rpc.close()
            return
        } catch ( error ) {
            last_error = error
        }
        await delay( 100 )
    }
    throw new Error( `Codex app server did not become ready: ${ last_error?.message }` )
}

/**
 * Run the original CLI, managing a shared Codex server for interactive sessions.
 * Both processes inherit the same effort endpoint; model tools run in the server.
 * @param {string[]} argv - Original command, optionally inside Babysit's capture launcher
 * @returns {Promise<number>} CLI exit status after all owned processes stop
 */
export async function launch( argv ) {

    // Capture sets its root PID immediately before exec. Keep that boundary
    // around each actual CLI process, not around this two-process supervisor.
    const capture = argv[ 0 ] === `python3` && argv[ 1 ] === `/home/node/.babysit-capture/capture.py` && argv[ 2 ] === `launch` && [ `codex`, `opencode` ].includes( argv[ 3 ] ) && basename( argv[ 4 ] || `` ) === argv[ 3 ]
    const prefix = capture ? argv.slice( 0, 4 ) : []
    const [ executable, ...args ] = argv.slice( prefix.length )
    if( !executable ) throw new Error( `Missing agent executable.` )
    const spawn_agent = ( child_args, options ) => prefix.length ? child_process( prefix[ 0 ], [ ...prefix.slice( 1 ), executable, ...child_args ], options ) : child_process( executable, child_args, options )
    const agent = basename( executable )
    const plan = agent === `codex` ? codex_launch_plan( args ) : agent === `opencode` ? opencode_launch_plan( args ) : { managed: false }
    if( plan.warning ) process.stderr.write( `babysit: ${ plan.warning }\n` )

    const children = []
    let tui
    let completion_observer
    let interrupted
    let resolve_signal
    const signal_received = new Promise( resolve_signal_promise => {
        resolve_signal = resolve_signal_promise
    } )
    const signal_handlers = [ `SIGINT`, `SIGTERM`, `SIGHUP` ].map( signal => {
        const handler = () => {
            interrupted = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[ signal ]
            resolve_signal( { code: interrupted } )
        }
        process.on( signal, handler )
        return [ signal, handler ]
    } )
    const resize = () => {
        if( tui?.pid ) signal_pid( tui.pid, `SIGWINCH` )
    }
    process.on( `SIGWINCH`, resize )

    try {
        let env = { ...process.env }
        let tui_args = args
        let server

        // Do not expose a stale parent session's endpoint to a passthrough CLI.
        delete env.BABYSIT_EFFORT_AGENT
        delete env.BABYSIT_EFFORT_ENDPOINT
        delete env.BABYSIT_EFFORT_SESSION_ID
        delete env.BABYSIT_EFFORT_DIRECTORY

        if( plan.managed && agent === `codex` ) {
            const endpoint = `ws://127.0.0.1:${ await free_port() }`
            env = { ...env, BABYSIT_EFFORT_AGENT: `codex`, BABYSIT_EFFORT_ENDPOINT: endpoint }
            server = spawn_agent( [ ...plan.server_args, `--listen`, endpoint ], { env, cwd: plan.cwd, detached: true, stdio: [ `ignore`, `ignore`, `inherit` ] } )
            children.push( server )
            await Promise.race( [ wait_for_server( server, endpoint ), signal_received, server.done.then( result => {
                throw result.error || new Error( `Codex app server exited before becoming ready.` )
            } ) ] )
            if( interrupted ) return interrupted
            if( capture ) completion_observer = await observe_completions( endpoint, { env, args: [ executable, ...args ] } )
            // The TUI passes its local config into thread/start, so it must
            // enable the feature too rather than override the server default.
            const separator = args.indexOf( `--` )
            const option_end = separator < 0 ? args.length : separator
            // Remote pickers otherwise omit their workspace filter, including
            // resume --last. This server shares the TUI's local filesystem.
            const cwd_args = plan.cwd ? [] : [ `--cd`, process.cwd() ]
            tui_args = [ `--remote`, endpoint, ...cwd_args, ...args.slice( 0, option_end ), `-c`, `features.step_model_switching=true`, ...args.slice( option_end ) ]
        }

        if( plan.managed && agent === `opencode` ) {
            const port = plan.port || await free_port()
            env = { ...env, BABYSIT_EFFORT_AGENT: `opencode`, BABYSIT_EFFORT_ENDPOINT: `http://127.0.0.1:${ port }`, OPENCODE_CONFIG_CONTENT: plan.config_content }
            tui_args = [ `--hostname`, `127.0.0.1`, `--port`, String( port ), `--mdns=false`, ...plan.tui_args ]
        }

        tui = spawn_agent( tui_args, { env, stdio: `inherit` } )
        children.push( tui )
        const result = await Promise.race( [ tui.done, signal_received, ... server ? [ server.done.then( result => ( { error: result.error || new Error( `Codex app server exited while its TUI was running.` ) } ) ) ] : []  ] )
        if( result.error ) throw result.error
        return interrupted || result.code || ( result.signal ? 128 + ( constants.signals[ result.signal ] || 0 ) : 0 )
    } finally {
        try {
            await completion_observer?.close()
        } finally {
            await stop_children( children )
            signal_handlers.forEach( ( [ signal, handler ] ) => process.off( signal, handler ) )
            process.off( `SIGWINCH`, resize )
        }
    }

}

if( process.argv[ 1 ] && import.meta.url === pathToFileURL( resolve( process.argv[ 1 ] ) ).href ) {
    launch( process.argv.slice( 2 ) ).then( code => {
        process.exitCode = code
    } ).catch( error => {
        process.stderr.write( `babysit: ${ error.message }\n` )
        process.exitCode = 1
    } )
}
