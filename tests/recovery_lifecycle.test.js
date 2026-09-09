import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir, hostname } from 'os'
import { join } from 'path'
import { parse_args } from '../src/cli/parse.js'
import { recover_session, recovery_blocker } from '../src/cli/recover.js'
import { continue_recovered_session } from '../src/sessions/continuation.js'
import { get_boot_id } from '../src/sessions/lock.js'
import { workspace_config_hash } from '../src/sessions/recovery.js'

const fixture = () => {
    const workspace = mkdtempSync( join( tmpdir(), `babysit-recover-policy-` ) )
    writeFileSync( join( workspace, `babysit.yaml` ), `config: {}\nbabysit: []\n` )
    const session = {
        babysit_id: `launch`, agent: `codex`, pwd: workspace, host: hostname(),
        recovery_version: 1, expected_open: true, agent_session_id: `native-id`, agent_session_id_source: `structured`,
        boot_id: get_boot_id(), docker_id: `daemon`, tmux_session: `pane`, pane_id: `%1`,
        monitor_token: `token`, container_id: `container`, image_id: `sha256:${ `a`.repeat( 64 ) }`,
        launch_spec: { args: [ `--model`, `model` ], config_hash: workspace_config_hash( workspace ) },
    }
    const calls = []
    const dependencies = {
        load: () => session,
        update: ( id, fields ) => {
            const changes = typeof fields === `function` ? fields( session ) : fields
            if( !changes ) return null
            calls.push( [ `update`, changes ] )
            return Object.assign( session, changes )
        },
        lock: () => { calls.push( [ `lock` ] ); return () => calls.push( [ `unlock` ] ) },
        sessions: async () => [],
        pane: async () => ( { pane_id: `%1` } ),
        inspect: async () => null,
        monitor_alive: () => false,
        identity: async () => ( { docker_id: `daemon` } ),
        verify: async () => calls.push( [ `verify` ] ),
        durable_identity: async () => null,
        durable_exit: async () => null,
        reconcile: async () => calls.push( [ `reconcile` ] ),
        start: async cmd => { calls.push( [ `start`, cmd ] ); return { babysit_id: `new` } },
        spawn_monitor: async () => { calls.push( [ `monitor` ] ); return 123 },
        wait_continuation: async () => ( { continuation: `sent` } ),
    }
    return { session, dependencies, calls, dispose: () => rmSync( workspace, { recursive: true, force: true } ) }
}

describe( `recovery command contract`, () => {
    it( `separates manual recovery from boot setup and rejects ambiguous options`, () => {
        expect( parse_args( [ `recover` ] ).verb ).toBe( `recover` )
        expect( parse_args( [ `recover`, `init` ] ).recover_verb ).toBe( `init` )
        expect( parse_args( [ `recover`, `id`, `--no-continue`, `--json` ] ).flags.no_continue ).toBe( true )
        expect( parse_args( [ `recover`, `--dry-run`, `id` ] ).session_id ).toBe( `id` )
        expect( () => parse_args( [ `recover`, `init`, `--no-continue` ] ) ).toThrow()
        expect( () => parse_args( [ `recover`, `--shutdown`, `id` ] ) ).toThrow()
        expect( () => parse_args( [ `close` ] ) ).toThrow()
    } )

    it( `dry-run verifies exact history but never launches, updates or reconciles`, async () => {
        const f = fixture()
        try {
            expect( ( await recover_session( f.session, { dry_run: true }, f.dependencies ) ).status ).toBe( `recoverable` )
            expect( f.calls.map( call => call[0] ) ).toEqual( [ `lock`, `verify`, `unlock` ] )
        } finally { f.dispose() }
    } )

    it( `repairs a surviving agent without replaying or sending continuation`, async () => {
        const f = fixture()
        try {
            f.dependencies.sessions = async () => [ { name: `pane` } ]
            f.dependencies.inspect = async () => `running`
            expect( ( await recover_session( f.session, {}, f.dependencies ) ).status ).toBe( `repaired` )
            expect( f.calls.some( call => [ `start`, `reconcile`, `verify` ].includes( call[0] ) ) ).toBe( false )
            expect( f.calls.filter( call => call[0] === `monitor` ) ).toHaveLength( 1 )
        } finally { f.dispose() }
    } )

    it( `fails closed on Docker or pane identity uncertainty`, async () => {
        const f = fixture()
        try {
            f.dependencies.identity = async () => ( { docker_id: `different` } )
            await expect( recover_session( f.session, {}, f.dependencies ) ).rejects.toThrow( `Docker daemon differs` )
            f.dependencies.identity = async () => ( { docker_id: `daemon` } )
            f.dependencies.sessions = async () => [ { name: `pane` } ]
            f.dependencies.pane = async () => ( { pane_id: `%2` } )
            await expect( recover_session( f.session, {}, f.dependencies ) ).rejects.toThrow( `Tmux launch identity differs` )
            expect( f.calls.filter( call => call[0] === `unlock` ) ).toHaveLength( 2 )
        } finally { f.dispose() }
    } )

    it( `preserves uncertainty after a crash while sending`, async () => {
        const f = fixture()
        try {
            f.session.continuation = `sending`
            expect( ( await recover_session( f.session, {}, f.dependencies ) ).status ).toBe( `blocked` )
            expect( f.calls.some( call => call[0] === `start` ) ).toBe( false )
            expect( ( await recover_session( f.session, { no_continue: true }, f.dependencies ) ).status ).toBe( `recovered` )
            const launch = f.calls.find( call => call[0] === `start` )[1]
            expect( launch.no_continue ).toBe( true )
            expect( launch.session_id ).toBe( `native-id` )
            expect( launch.detached ).toBe( true )
        } finally { f.dispose() }
    } )

    it( `excludes closed, sandbox and unknown history; detects config drift`, () => {
        const f = fixture()
        try {
            expect( recovery_blocker( f.session ) ).toBeNull()
            expect( recovery_blocker( { ...f.session, expected_open: false } ) ).toContain( `closed` )
            expect( recovery_blocker( { ...f.session, modifiers: [ `sandbox` ] } ) ).toContain( `ephemeral` )
            expect( recovery_blocker( { ...f.session, recovery_version: undefined } ) ).toContain( `Legacy` )
            writeFileSync( join( f.session.pwd, `babysit.yaml` ), `changed` )
            expect( recovery_blocker( f.session ) ).toContain( `configuration changed` )
        } finally { f.dispose() }
    } )
} )

describe( `continuation crash boundary`, () => {
    it( `journals before input and never repeats an uncertain delivery`, async () => {
        const f = fixture()
        const submitted = []
        try {
            f.session.continuation = `pending`
            const dependencies = {
                ...f.dependencies,
                ready: async () => true,
                read_identity: async () => ( { session_id: `native-id` } ),
                send: async ( target, text ) => {
                    expect( f.session.continuation ).toBe( `sending` )
                    submitted.push( [ target, text ] )
                    throw new Error( `Lost connection after Enter` )
                },
            }
            expect( await continue_recovered_session( f.session, dependencies ) ).toBe( `sending` )
            expect( await continue_recovered_session( f.session, dependencies ) ).toBe( `sending` )
            expect( submitted ).toHaveLength( 1 )
            expect( submitted[0][0] ).toBe( `%1` )
        } finally { f.dispose() }
    } )

    it( `does not type into a different conversation or after explicit closure`, async () => {
        const f = fixture()
        let sends = 0
        try {
            f.session.continuation = `pending`
            const dependencies = { ...f.dependencies, ready: async () => true, read_identity: async () => ( { session_id: `other` } ), send: async () => sends++ }
            expect( await continue_recovered_session( f.session, dependencies ) ).toBe( `blocked` )
            f.session.continuation = `pending`
            f.session.expected_open = false
            dependencies.read_identity = async () => null
            await continue_recovered_session( f.session, dependencies )
            expect( sends ).toBe( 0 )
        } finally { f.dispose() }
    } )
} )
