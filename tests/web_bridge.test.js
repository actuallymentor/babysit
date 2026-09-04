import { afterEach, describe, expect, it } from 'bun:test'
import {
    chmodSync,
    linkSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { create_web_bridge, open_web_bridge, web_bridge_initialized } from '../src/web_bridge/bridge.js'
import { initialize_web_bridge } from '../src/web_bridge/init.js'

const temporary_directories = []

const make_directory = () => {
    const directory = mkdtempSync( join( tmpdir(), `babysit-web-bridge-test-` ) )
    temporary_directories.push( directory )
    return directory
}

const make_session = () => ( {
    babysit_id: `20260904-120000-abcdef123456`,
    name: `Feature\u0000 one`,
    agent: `codex`,
    tmux_session: `babysit_feature_codex_1`,
    pwd: `/home/mentor/projects/babysit`,
    modifiers: [ `yolo`, `docker` ],
} )

const write_request = ( directory, request, { mtime = null } = {} ) => {
    const filename = `${ request.session_id }--${ request.epoch }--${ request.request_id }.json`
    const path = join( directory, `requests`, filename )
    writeFileSync( path, JSON.stringify( request ) )
    if( mtime ) utimesSync( path, mtime, mtime )
    return { filename, path }
}

const make_request = ( overrides = {} ) => ( {
    protocol: 1,
    session_id: `20260904-120000-abcdef123456`,
    epoch: `launch-epoch`,
    request_id: `123e4567-e89b-12d3-a456-426614174000`,
    kind: `text`,
    text: `Please continue\nwith the fix`,
    ...overrides,
} )

afterEach( () => {
    temporary_directories.splice( 0 ).forEach( directory => rmSync( directory, { recursive: true, force: true } ) )
} )

describe( `web bridge initialization`, () => {

    it( `creates private capabilities and persists only the token hash`, () => {
        const directory = make_directory()
        const first = initialize_web_bridge( {
            directory,
            random_bytes: () => Buffer.alloc( 32, 1 ),
        } )
        const access_text = readFileSync( first.paths.access, `utf8` )

        expect( first.token ).toHaveLength( 43 )
        expect( access_text ).not.toContain( first.token )
        expect( JSON.parse( access_text ) ).toMatchObject( {
            protocol: 1,
            role: `write`,
            token_sha256: `56d5fa7333f6d747db42c239407e5da4c32f4c79f35d092b134fd35a402d9c5c`,
        } )
        expect( [ first.paths.root, first.paths.access_dir, first.paths.state, first.paths.requests, first.paths.inflight ]
            .map( path => lstatSync( path ).mode & 0o777 ) ).toEqual( [ 0o700, 0o700, 0o700, 0o700, 0o700 ] )
        expect( lstatSync( first.paths.access ).mode & 0o777 ).toBe( 0o600 )
        expect( web_bridge_initialized( directory ) ).toBe( true )

        const rotated = initialize_web_bridge( {
            directory,
            random_bytes: () => Buffer.alloc( 32, 2 ),
        } )
        expect( rotated.token ).not.toBe( first.token )
        expect( readFileSync( rotated.paths.access, `utf8` ) ).not.toContain( first.access.token_sha256 )
    } )

    it( `refuses a bridge with group-readable capabilities`, () => {
        const directory = make_directory()
        const { paths } = initialize_web_bridge( { directory } )

        chmodSync( paths.access, 0o640 )

        expect( web_bridge_initialized( directory ) ).toBe( false )
    } )

    it( `does not follow a pre-existing directory symlink`, () => {
        const directory = make_directory()
        const outside = make_directory()
        symlinkSync( outside, join( directory, `state` ) )

        expect( () => initialize_web_bridge( { directory } ) ).toThrow( `not a real directory` )
        expect( lstatSync( outside ).mode & 0o777 ).toBe( 0o700 )
    } )

} )

describe( `per-session web bridge`, () => {

    const setup = ( options = {} ) => {
        const directory = make_directory()
        initialize_web_bridge( { directory } )
        const sent = []
        const bridge = create_web_bridge( {
            session: make_session(),
            tmux_target: `%42`,
            directory,
            epoch: `launch-epoch`,
            attachment_fn: async () => `detached`,
            send_text_fn: async ( ...args ) => sent.push( args ),
            ...options,
        } )
        return { bridge, directory, sent }
    }

    it( `publishes only the allowlisted state and captures the stable screen`, async () => {
        const { bridge, directory } = setup()

        await bridge.publish( { output: `# Result\u0000\n\nDone\u001b`, activity: `running` } )
        await bridge.publish( { output: `# Result\u0000\n\nDone\u001b`, activity: `idle` } )

        const state_path = join( directory, `state`, `${ bridge.session_id }.json` )
        const state = JSON.parse( readFileSync( state_path, `utf8` ) )

        expect( Object.keys( state ).sort() ).toEqual( [
            `activity`, `agent`, `attachment`, `busy`, `directory`, `epoch`, `last_message`,
            `modifiers`, `name`, `protocol`, `raw_screen`, `results`, `revision`, `session_id`, `updated_at`,
        ].sort() )
        expect( state ).toMatchObject( {
            protocol: 1,
            session_id: make_session().babysit_id,
            epoch: `launch-epoch`,
            name: `Feature one`,
            agent: `codex`,
            activity: `idle`,
            attachment: `detached`,
            busy: false,
            directory: `projects/babysit`,
            last_message: `# Result\n\nDone`,
            raw_screen: `# Result\n\nDone`,
            revision: 1,
        } )
        expect( state.tmux_session ).toBeUndefined()
        expect( state.pwd ).toBeUndefined()

        bridge.close()
        expect( lstatSync( join( directory, `state` ) ).isDirectory() ).toBe( true )
        expect( readdirSync( join( directory, `state` ) ) ).toEqual( [] )
    } )

    it( `claims one valid request and sends it only to the exact pane id`, async () => {
        const { bridge, directory, sent } = setup()
        await bridge.publish( { output: `ready`, activity: `idle` } )
        const request = make_request()
        write_request( directory, request, { mtime: new Date( Date.now() + 10_000 ) } )

        const result = await bridge.process_requests()
        const state = JSON.parse( readFileSync( join( directory, `state`, `${ bridge.session_id }.json` ), `utf8` ) )

        expect( result ).toEqual( { sent: true, processed: 1 } )
        expect( sent ).toEqual( [ [ `%42`, request.text, { redact: true } ] ] )
        expect( readdirSync( join( directory, `requests` ) ) ).toEqual( [] )
        expect( readdirSync( join( directory, `inflight` ) ) ).toEqual( [] )
        expect( state.results.at( -1 ) ).toMatchObject( {
            request_id: request.request_id,
            status: `accepted`,
            message: `Message sent`,
        } )
    } )

    it( `leaves later messages queued after one successful send`, async () => {
        const { bridge, directory, sent } = setup()
        await bridge.publish( { output: `ready`, activity: `idle` } )
        write_request( directory, make_request() )
        write_request( directory, make_request( { request_id: `223e4567-e89b-12d3-a456-426614174000` } ) )

        await bridge.process_requests()

        expect( sent ).toHaveLength( 1 )
        expect( readdirSync( join( directory, `requests` ) ) ).toHaveLength( 1 )
    } )

    it( `does not lose a successful delivery when result publication fails`, async () => {
        const { bridge, directory, sent } = setup()
        await bridge.publish( { output: `ready`, activity: `idle` } )
        write_request( directory, make_request() )
        chmodSync( join( directory, `state` ), 0o500 )

        try {
            expect( await bridge.process_requests() ).toEqual( { sent: true, processed: 1 } )
            expect( sent ).toHaveLength( 1 )
        } finally {
            chmodSync( join( directory, `state` ), 0o700 )
        }
    } )

    it( `rejects controls, stale files, extra schema, busy input, and retained hard links`, async () => {
        const cases = [
            { request: make_request( { text: `unsafe\u001binput` } ), expected: `unsafe control` },
            { request: make_request( { request_id: `expired`, text: `old` } ), mtime: new Date( Date.now() - 21_000 ), expected: `expired` },
            { request: make_request( { request_id: `future` } ), mtime: new Date( Date.now() + 31_000 ), expected: `expired` },
            { request: { ...make_request( { request_id: `extra` } ), tmux_session: `victim` }, expected: `schema` },
        ]

        for( const [ index, test_case ] of cases.entries() ) {
            const { bridge, directory, sent } = setup()
            await bridge.publish( { output: `ready`, activity: `idle` } )
            write_request( directory, test_case.request, { mtime: test_case.mtime } )

            await bridge.process_requests()

            const state = JSON.parse( readFileSync( join( directory, `state`, `${ bridge.session_id }.json` ), `utf8` ) )
            expect( sent, `case ${ index }` ).toEqual( [] )
            expect( state.results.at( -1 ).status ).toBe( `rejected` )
            expect( state.results.at( -1 ).message.toLowerCase() ).toContain( test_case.expected )
        }

        const busy = setup()
        await busy.bridge.publish( { output: `ready`, activity: `running`, busy: true } )
        write_request( busy.directory, make_request() )
        await busy.bridge.process_requests( { busy: true } )
        expect( busy.sent ).toEqual( [] )

        const linked = setup()
        await linked.bridge.publish( { output: `ready`, activity: `idle` } )
        const { path } = write_request( linked.directory, make_request() )
        linkSync( path, join( linked.directory, `requests`, `retained-link` ) )
        await linked.bridge.process_requests()
        expect( linked.sent ).toEqual( [] )

        const directory_request = setup()
        await directory_request.bridge.publish( { output: `ready`, activity: `idle` } )
        const request = make_request()
        const filename = `${ request.session_id }--${ request.epoch }--${ request.request_id }.json`
        mkdirSync( join( directory_request.directory, `requests`, filename ) )
        await directory_request.bridge.process_requests()
        expect( directory_request.sent ).toEqual( [] )
        expect( readdirSync( join( directory_request.directory, `inflight` ) ) ).toEqual( [] )
    } )

    it( `ignores requests for an old launch epoch`, async () => {
        const { bridge, directory, sent } = setup()
        await bridge.publish( { output: `ready`, activity: `idle` } )
        write_request( directory, make_request( { epoch: `old-epoch` } ) )

        expect( await bridge.process_requests() ).toEqual( { sent: false, processed: 0 } )
        expect( sent ).toEqual( [] )
        expect( readdirSync( join( directory, `requests` ) ) ).toHaveLength( 1 )
    } )

    it( `opens only initialized bridges and resolves an exact pane`, async () => {
        const empty_directory = make_directory()
        expect( await open_web_bridge( { session: make_session(), directory: empty_directory } ) ).toBeNull()

        initialize_web_bridge( { directory: empty_directory } )
        const targets = []
        const bridge = await open_web_bridge( {
            session: make_session(),
            directory: empty_directory,
            resolve_pane: async target => {
                targets.push( target )
                return { pane_id: `%7`, attachment: `detached` }
            },
            bridge_options: { attachment_fn: async () => `detached` },
        } )

        expect( targets ).toEqual( [ make_session().tmux_session ] )
        expect( bridge.tmux_target ).toBe( `%7` )
    } )

} )
