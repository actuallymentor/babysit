import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { build_launch_yaml, default_launch } from '../src/babysit/launch_config.js'
import { cmd_launch_dir, read_launch_dir } from '../src/cli/compose.js'
import { parse_args } from '../src/cli/parse.js'

let dir
const autonomy = process.env.AGENT_AUTONOMY_MODE

beforeEach( () => {
    dir = realpathSync( mkdtempSync( join( tmpdir(), `babysit-compose-` ) ) )
    // Ambient yolo mode silences the restricted-Docker warning
    delete process.env.AGENT_AUTONOMY_MODE
} )

afterEach( () => {
    rmSync( dir, { recursive: true, force: true } )
    if( autonomy !== undefined ) process.env.AGENT_AUTONOMY_MODE = autonomy
} )

const write = ( file, launch = default_launch() ) => writeFileSync( join( dir, file ), build_launch_yaml( launch ) )

const run = async ( { yes = false, answer = true, running = [], interactive = true, fail = [] } = {} ) => {

    const lines = []
    const started = []
    const asked = []
    const cwds = []
    const outcome = cmd_launch_dir( { verb: `launch`, flags: { config: dir, yes } }, {
        start: async cmd => {
            cwds.push( process.cwd() )
            // Like a clone launch, leave the process somewhere else
            process.chdir( tmpdir() )
            if( fail.includes( cmd.flags.name ) ) throw new Error( `boom` )
            started.push( cmd )
            return { babysit_id: `id-${ cmd.flags.name }` }
        },
        tmux_sessions: async () => running.map( ( _, index ) => ( { name: `tmux-${ index }` } ) ),
        stored_sessions: () => running.map( ( config_path, index ) => ( { babysit_id: `live-${ index }`, config_path, tmux_session: `tmux-${ index }` } ) ),
        ask: async question => ( asked.push( question ), answer ),
        interactive,
        print: line => lines.push( line ),
    } )

    return { outcome, lines, started, asked, cwds }

}

describe( `babysit --config DIR/`, () => {

    it( `parses a directory like a file and lets --yes through to the launch`, () => {
        expect( parse_args( [ `--config`, dir, `--yes` ] ) ).toMatchObject( { verb: `launch`, flags: { config: dir, yes: true, name: false } } )
    } )

    it( `shows the overview, asks once, and starts each yaml detached with derived names`, async () => {
        write( `api.yaml`, default_launch( { agent: `codex`, adb: true, docker: true, mode: `sandbox`, args: [ `-m`, `x` ] } ) )
        write( `web.yml`, default_launch( { name: `frontend`, loop: true } ) )
        writeFileSync( join( dir, `notes.md` ), `not yaml` )
        mkdirSync( join( dir, `nested` ) )
        writeFileSync( join( dir, `nested`, `deep.yaml` ), `launch: {}` )

        const { outcome, lines, started, asked } = await run()
        await outcome

        expect( asked ).toEqual( [ `Start 2 sessions? [y/N] ` ] )
        const overview = lines.join( `\n` )
        expect( overview ).toMatch( /start\s+api\.yaml\s+api\s+codex\s+--docker --adb --sandbox\s+-- -m x/ )
        expect( overview ).toMatch( /start\s+web\.yml\s+frontend\s+claude\s+--loop/ )
        expect( overview ).toContain( `! api.yaml: --docker` )

        expect( started.map( cmd => [ cmd.flags.name, cmd.agent, cmd.flags.config, cmd.detached, cmd.batch, cmd.flags.yes ] ) ).toEqual( [
            [ `api`, `codex`, join( dir, `api.yaml` ), true, true, true ],
            [ `frontend`, `claude`, join( dir, `web.yml` ), true, true, true ],
        ] )
        expect( started[0].passthrough ).toEqual( [ `-m`, `x` ] )
        expect( lines ).toContain( `Started api.yaml: babysit open id-api` )
    } )

    it( `never starts a yaml whose session is still running, even through a symlinked path`, async () => {
        write( `api.yaml` )
        write( `web.yaml` )
        const alias = `${ dir }-alias`
        symlinkSync( dir, alias )
        try {
            const { outcome, lines, started, asked } = await run( { running: [ join( alias, `api.yaml` ) ] } )
            await outcome
            expect( lines.join( `\n` ) ).toMatch( /running\s+api\.yaml.*already live-0; skipped/ )
            expect( asked ).toEqual( [ `Start 1 session? [y/N] ` ] )
            expect( started.map( cmd => cmd.flags.name ) ).toEqual( [ `web` ] )

            const all = await run( { running: [ join( dir, `api.yaml` ), join( dir, `web.yaml` ) ] } )
            await all.outcome
            expect( all.asked ).toEqual( [] )
            expect( all.lines.at( -1 ) ).toBe( `Every session is already running.` )
        } finally {
            rmSync( alias )
        }
    } )

    it( `starts nothing on no, and needs --yes without a terminal`, async () => {
        write( `api.yaml` )

        const declined = await run( { answer: false } )
        await declined.outcome
        expect( declined.started ).toEqual( [] )
        expect( declined.lines.at( -1 ) ).toBe( `Nothing started.` )

        await expect( ( await run( { interactive: false } ) ).outcome ).rejects.toThrow( /pass --yes/ )

        const confirmed = await run( { interactive: false, yes: true } )
        await confirmed.outcome
        expect( confirmed.asked ).toEqual( [] )
        expect( confirmed.started ).toHaveLength( 1 )
    } )

    it( `refuses the whole directory when any yaml is incomplete`, async () => {
        write( `api.yaml` )
        writeFileSync( join( dir, `bad.yaml` ), `launch:\n    agent: claude\n    yolo:\n` )
        writeFileSync( join( dir, `01.yaml` ), build_launch_yaml( default_launch() ) )

        const { outcome, started } = await run()
        await expect( outcome ).rejects.toThrow( /01\.yaml: --name cannot contain only digits[\s\S]*bad\.yaml: launch\.yolo is required/ )
        expect( started ).toEqual( [] )
        expect( read_launch_dir( dir ).errors.length ).toBeGreaterThan( 2 )
    } )

    it( `keeps going past a failed start, in the launch directory, and reports it`, async () => {
        write( `api.yaml` )
        write( `web.yaml` )
        const cwd = process.cwd()
        const { outcome, lines, started, cwds } = await run( { fail: [ `api` ] } )
        await expect( outcome ).rejects.toThrow( /1 of 2 sessions did not start: api\.yaml/ )
        expect( cwds ).toEqual( [ cwd, cwd ] )
        expect( process.cwd() ).toBe( cwd )
        expect( started.map( cmd => cmd.flags.name ) ).toEqual( [ `web` ] )
        expect( lines ).toContain( `Failed api.yaml: boom` )
    } )

    it( `errors on a directory without yaml files`, async () => {
        await expect( ( await run() ).outcome ).rejects.toThrow( /No \.yaml or \.yml files/ )
    } )

} )
