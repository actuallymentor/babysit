import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'child_process'
import {
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
    clone_state_paths,
    CLONE_STATE_MAGIC,
    CLONE_STATE_VERSION,
    prepare_clone_workspace,
    acquire_clone_lock,
} from '../src/clone.js'
import {
    clone_directory_size,
    list_managed_clones,
    prune_managed_clone,
    recover_prune_operations,
} from '../src/prune.js'
import {
    clone_last_used_at,
    cmd_prune,
    inspect_clone_inventory,
    parse_prune_days,
    select_prune_candidates,
} from '../src/cli/prune.js'
import { load_session, save_session, update_session } from '../src/sessions/store.js'
import { list_sessions } from '../src/tmux/session.js'

const DAY_MS = 24 * 60 * 60 * 1_000

const output_collector = () => {

    let rendered = ``
    return {
        output: { write: chunk => { rendered += String( chunk ) } },
        rendered: () => rendered,
    }

}

describe( `clone prune storage`, () => {

    let directory
    let clones_dir
    let sessions_dir
    let source_index

    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-prune-test-` ) )
        clones_dir = join( directory, `clones` )
        sessions_dir = join( directory, `sessions` )
        source_index = 0
    } )

    afterEach( () => {
        rmSync( directory, { recursive: true, force: true } )
    } )

    const create_clone = ( clone_id = `clone-one` ) => {

        const source = join( directory, `source-${ ++source_index }` )
        mkdirSync( source )
        writeFileSync( join( source, `file.txt` ), `clone data\n` )

        return prepare_clone_workspace( { source, clone_id, clones_dir } )

    }

    it( `inventories only manifest-owned clone directories`, () => {

        create_clone()
        mkdirSync( join( clones_dir, `unknown` ) )
        symlinkSync( join( directory, `source-1` ), join( clones_dir, `redirected` ) )
        const paths = clone_state_paths( clones_dir )
        writeFileSync( join( paths.manifests, `invalid.json` ), `{ "status": "complete" }` )

        const inventory = list_managed_clones( { clones_dir } )

        expect( inventory.clones.map( clone => clone.clone_id ) ).toEqual( [ `clone-one` ] )
        expect( inventory.ignored_entries.map( path => path.split( `/` ).pop() ).sort() )
            .toEqual( [ `redirected`, `unknown` ] )
        expect( inventory.invalid_manifests ).toHaveLength( 1 )
        expect( inventory.ignored_entries ).not.toContain( join( clones_dir, `.babysit-state` ) )

    } )

    it( `measures allocated clone size without following symlinks or double-counting hardlinks`, () => {

        const clone = create_clone()
        const payload = join( clone.workspace, `payload.bin` )
        const hardlink = join( clone.workspace, `payload-hardlink.bin` )
        const external = join( directory, `external.bin` )
        writeFileSync( payload, Buffer.alloc( 1024 * 1024, 7 ) )
        writeFileSync( external, Buffer.alloc( 4 * 1024 * 1024, 9 ) )

        const single_size = clone_directory_size( clone.workspace )
        linkSync( payload, hardlink )
        symlinkSync( external, join( clone.workspace, `external-link` ) )
        const linked_size = clone_directory_size( clone.workspace )
        unlinkSync( join( clone.workspace, `external-link` ) )
        unlinkSync( hardlink )

        expect( linked_size ).toBeLessThan( single_size + 4 * 1024 * 1024 )
        expect( linked_size - single_size ).toBeLessThan( 16 * 1024 )

    } )

    it( `uses session completion and record update times as last use`, () => {

        const now = Date.now()
        const clone = { created_at: new Date( now - 90 * DAY_MS ).toISOString() }
        const records = [ {
            updated_at: new Date( now - DAY_MS ).toISOString(),
            session: {
                started_at: new Date( now - 60 * DAY_MS ).toISOString(),
                ended_at: new Date( now - 2 * DAY_MS ).toISOString(),
            },
        } ]

        expect( clone_last_used_at( clone, records ) ).toBe( now - DAY_MS )

    } )

    it( `protects live clone families and fails closed on registry or tmux errors`, async () => {

        const clone = create_clone()
        save_session( {
            babysit_id: `session-one`,
            clone: true,
            clone_id: clone.clone_id,
            clone_path: clone.clone_path,
            tmux_session: `babysit_live`,
            status: `active`,
            started_at: new Date().toISOString(),
        }, { directory: sessions_dir } )

        const active = await inspect_clone_inventory( {
            clones_dir,
            sessions_dir,
            get_cwd: () => directory,
            list_tmux: async () => [ { name: `babysit_live` } ],
        } )
        expect( active.clones[0] ).toMatchObject( {
            active: true,
            available: false,
            status: `active: tmux`,
        } )

        const failed_tmux = await inspect_clone_inventory( {
            clones_dir,
            sessions_dir,
            get_cwd: () => directory,
            list_tmux: async () => { throw new Error( `tmux unavailable` ) },
        } )
        expect( failed_tmux.clones[0].status ).toBe( `protected: tmux check failed` )

        writeFileSync( join( sessions_dir, `broken.json` ), `{` )
        const broken_registry = await inspect_clone_inventory( {
            clones_dir,
            sessions_dir,
            get_cwd: () => directory,
            list_tmux: async () => [],
        } )
        expect( broken_registry.clones[0].status ).toBe( `protected: session registry unreadable` )

    } )

    it( `protects a tmux-less clone whose Docker container is still running`, async () => {

        const clone = create_clone()
        save_session( {
            babysit_id: `session-container`,
            clone: true,
            clone_id: clone.clone_id,
            clone_path: clone.clone_path,
            tmux_session: `babysit_gone`,
            container_id: `container-one`,
            status: `active`,
            started_at: new Date().toISOString(),
        }, { directory: sessions_dir } )

        const inventory = await inspect_clone_inventory( {
            clones_dir,
            sessions_dir,
            get_cwd: () => directory,
            list_tmux: async () => [],
            monitor_alive: () => false,
            inspect_container: async () => `running`,
        } )

        expect( inventory.clones[0].status ).toBe( `active: container` )

    } )

    it( `fails closed when a live Babysit tmux session has no owner record`, async () => {

        create_clone()
        const inventory = await inspect_clone_inventory( {
            clones_dir,
            sessions_dir,
            get_cwd: () => directory,
            list_tmux: async () => [ { name: `babysit_without_metadata` } ],
        } )

        expect( inventory.unowned_tmux_sessions ).toEqual( [ { name: `babysit_without_metadata` } ] )
        expect( inventory.clones[0].status ).toBe( `protected: session ownership unknown` )

    } )

    it( `selects the default threshold exactly and supports all unused`, () => {

        const now = Date.now()
        const clones = [
            { clone_id: `old`, available: true, last_used_at: now - 30 * DAY_MS },
            { clone_id: `recent`, available: true, last_used_at: now - 29 * DAY_MS },
            { clone_id: `active`, available: false, last_used_at: now - 90 * DAY_MS },
        ]

        expect( select_prune_candidates( clones, { mode: `days`, days: 30 }, now )
            .map( clone => clone.clone_id ) ).toEqual( [ `old` ] )
        expect( select_prune_candidates( clones, { mode: `all` }, now )
            .map( clone => clone.clone_id ) ).toEqual( [ `old`, `recent` ] )

    } )

    it( `limits focused revalidation to the requested clone family`, async () => {

        const first = create_clone( `first-clone` )
        create_clone( `second-clone` )
        const inventory = await inspect_clone_inventory( {
            clones_dir,
            sessions_dir,
            clone_ids: [ first.clone_id ],
            get_cwd: () => directory,
            list_tmux: async () => [],
        } )

        expect( inventory.clones.map( ( { clone_id } ) => clone_id ) ).toEqual( [ first.clone_id ] )

    } )

    it( `quarantines a clone and marks every family session as pruned`, async () => {

        const clone = create_clone()
        for( const babysit_id of [ `session-one`, `session-two` ] ) {
            save_session( {
                babysit_id,
                clone: true,
                clone_id: clone.clone_id,
                clone_path: clone.clone_path,
                started_at: new Date().toISOString(),
            }, { directory: sessions_dir } )
        }
        save_session( {
            babysit_id: `unrelated`,
            started_at: new Date().toISOString(),
        }, { directory: sessions_dir } )

        const [ managed ] = list_managed_clones( { clones_dir } ).clones
        const mark_sessions = async ( session_ids, pruned_at ) => session_ids.forEach(
            babysit_id => update_session( babysit_id, {
                status: `pruned`,
                clone_pruned_at: pruned_at,
            }, { directory: sessions_dir } )
        )
        const result = await prune_managed_clone( {
            clone: managed,
            session_ids: [ `session-one` ],
            clones_dir,
            mark_sessions,
            revalidate: async () => ( {
                session_ids: [ `session-one`, `session-two` ],
            } ),
        } )

        expect( result.pruned ).toBe( true )
        expect( existsSync( clone.clone_path ) ).toBe( false )
        expect( existsSync( managed.manifest_path ) ).toBe( false )
        expect( load_session( `session-one`, { directory: sessions_dir } ).status ).toBe( `pruned` )
        expect( load_session( `session-two`, { directory: sessions_dir } ).clone_pruned_at ).toBeString()
        expect( load_session( `unrelated`, { directory: sessions_dir } ).status ).toBeUndefined()

    } )

    it( `cannot prune through a live launch lock`, async () => {

        const clone = create_clone()
        const [ managed ] = list_managed_clones( { clones_dir } ).clones
        const release = acquire_clone_lock( clone.clone_path, { clones_dir } )

        try {
            await expect( prune_managed_clone( {
                clone: managed,
                session_ids: [],
                clones_dir,
                mark_sessions: async () => {},
                revalidate: async () => null,
            } ) ).rejects.toThrow( `already locked` )
        } finally {
            release()
        }

        expect( existsSync( clone.clone_path ) ).toBe( true )

    } )

    it( `recovers long clone ids through a symlinked root ancestor`, async () => {

        const actual_parent = join( directory, `actual-parent` )
        const linked_parent = join( directory, `linked-parent` )
        mkdirSync( actual_parent )
        symlinkSync( actual_parent, linked_parent, `dir` )
        clones_dir = join( linked_parent, `clones` )

        const clone = create_clone( `a`.repeat( 100 ) )
        const [ managed ] = list_managed_clones( { clones_dir } ).clones
        const paths = clone_state_paths( clones_dir )
        const trash_name = `${ clone.clone_id }-${ `b`.repeat( 36 ) }`
        const journal_path = join( paths.prune_journals, `interrupted.json` )
        renameSync( clone.clone_path, join( paths.trash, trash_name ) )
        writeFileSync( journal_path, JSON.stringify( {
            magic: CLONE_STATE_MAGIC,
            version: CLONE_STATE_VERSION,
            kind: `prune`,
            clone_id: clone.clone_id,
            clone_path: clone.clone_path,
            manifest_path: managed.manifest_path,
            trash_name,
            session_ids: [ `session-one` ],
            pruned_at: new Date().toISOString(),
        } ) )
        const marked = []

        const recovery = await recover_prune_operations( {
            clones_dir,
            mark_sessions: async session_ids => marked.push( ...session_ids ),
        } )

        expect( recovery.failed ).toEqual( [] )
        expect( recovery.recovered ).toEqual( [ clone.clone_id ] )
        expect( marked ).toEqual( [ `session-one` ] )
        expect( existsSync( join( paths.trash, trash_name ) ) ).toBe( false )
        expect( existsSync( managed.manifest_path ) ).toBe( false )
        expect( existsSync( journal_path ) ).toBe( false )

    } )

    it( `does not consume a journal owned by another prune process`, async () => {

        const clone = create_clone()
        const [ managed ] = list_managed_clones( { clones_dir } ).clones
        const paths = clone_state_paths( clones_dir )
        const trash_name = `${ clone.clone_id }-pending`
        const journal_path = join( paths.prune_journals, `pending.json` )
        writeFileSync( journal_path, JSON.stringify( {
            magic: CLONE_STATE_MAGIC,
            version: CLONE_STATE_VERSION,
            kind: `prune`,
            clone_id: clone.clone_id,
            clone_path: clone.clone_path,
            manifest_path: managed.manifest_path,
            trash_name,
            session_ids: [],
            pruned_at: new Date().toISOString(),
        } ) )
        const release = acquire_clone_lock( clone.clone_path, { clones_dir } )

        try {
            const recovery = await recover_prune_operations( {
                clones_dir,
                mark_sessions: async () => {},
            } )

            expect( recovery.recovered ).toEqual( [] )
            expect( recovery.failed ).toHaveLength( 1 )
            expect( recovery.failed[0].error.code ).toBe( `BABYSIT_CLONE_LOCKED` )
            expect( existsSync( journal_path ) ).toBe( true )
        } finally {
            release()
        }

    } )

    it( `rejects malformed prune journals without interpreting their paths`, async () => {

        create_clone()
        const paths = clone_state_paths( clones_dir )
        const journal_path = join( paths.prune_journals, `malformed.json` )
        writeFileSync( journal_path, JSON.stringify( {
            magic: CLONE_STATE_MAGIC,
            version: CLONE_STATE_VERSION,
            kind: `prune`,
            clone_id: `clone-one`,
            clone_path: join( clones_dir, `clone-one` ),
            manifest_path: join( paths.manifests, `clone-one.json` ),
            trash_name: { path: `clone-one-unsafe` },
            session_ids: [],
        } ) )

        const recovery = await recover_prune_operations( {
            clones_dir,
            mark_sessions: async () => {},
        } )

        expect( recovery.recovered ).toEqual( [] )
        expect( recovery.failed ).toHaveLength( 1 )
        expect( existsSync( join( clones_dir, `clone-one` ) ) ).toBe( true )

    } )

    it( `runs the real CLI list path with an isolated home`, () => {

        const home = join( directory, `home` )
        clones_dir = join( home, `.babysit`, `clones` )
        const clone = create_clone( `cli-clone` )

        const result = spawnSync( process.execPath, [
            join( process.cwd(), `src`, `index.js` ),
            `prune`,
            `--list`,
        ], {
            encoding: `utf8`,
            env: {
                ...process.env,
                HOME: home,
                BABYSIT_TMUX_SOCKET: `babysit-prune-${ process.pid }`,
            },
        } )

        expect( result.status ).toBe( 0 )
        expect( result.stdout ).toContain( `1 clone currently in ${ join( home, `.babysit`, `clones` ) }` )
        expect( result.stdout ).toContain( `cli-clone` )
        expect( result.stdout ).toContain( `SIZE` )
        expect( result.stderr ).toBe( `` )
        expect( existsSync( join( home, `.babysit`, `clones`, clone.clone_id ) ) ).toBe( true )

    } )

} )

describe( `prune command interaction`, () => {

    const now = Date.now()
    const clone = {
        clone_id: `old-clone`,
        clone_path: `/tmp/clones/old-clone`,
        name: `old task`,
        status: `available`,
        available: true,
        active: false,
        size_bytes: 2_048,
        last_used_at: now - 40 * DAY_MS,
        records: [ { session: { babysit_id: `old-session` } } ],
    }
    const inventory = {
        clone_root: `/tmp/clones`,
        clones: [ clone ],
        ignored_entries: [],
        invalid_manifests: [],
        pending_prunes: [],
        invalid_session_files: [],
        unowned_tmux_sessions: [],
        tmux_error: null,
    }

    it( `parses whole custom day amounts`, () => {
        expect( parse_prune_days( `0` ) ).toBe( 0 )
        expect( parse_prune_days( `45` ) ).toBe( 45 )
        expect( parse_prune_days( `-1` ) ).toBeNull()
        expect( parse_prune_days( `1.5` ) ).toBeNull()
        expect( parse_prune_days( `days` ) ).toBeNull()
    } )

    it( `lists every clone and its size without prompting`, async () => {

        const { output, rendered } = output_collector()
        await cmd_prune( { flags: { list: true } }, {
            output,
            inspect_inventory: async () => inventory,
            now: () => now,
        } )

        expect( rendered() ).toContain( `1 clone currently in /tmp/clones` )
        expect( rendered() ).toContain( `2.0 KiB` )
        expect( rendered() ).toContain( `/tmp/clones/old-clone` )

    } )

    it( `uses the 30-day default and requires explicit final confirmation`, async () => {

        const { output, rendered } = output_collector()
        const answers = [ ``, `yes` ]
        const pruned = []
        await cmd_prune( { flags: {} }, {
            input: { isTTY: true },
            output,
            ask: async () => answers.shift(),
            inspect_inventory: async () => inventory,
            recover_prunes: async () => ( { recovered: [], failed: [] } ),
            prune_clone: async options => {
                pruned.push( options.clone.clone_id )
                return { pruned: true, clone_id: options.clone.clone_id }
            },
            now: () => now,
        } )

        expect( pruned ).toEqual( [ `old-clone` ] )
        expect( rendered() ).toContain( `Unused for 30 days (default)` )
        expect( rendered() ).toContain( `Pruned 1 of 1 clone workspaces.` )

    } )

    it( `supports all-unused and custom-day choices`, async () => {

        for( const answers of [ [ `2`, `y` ], [ `3`, `invalid`, `0`, `y` ] ] ) {
            const { output } = output_collector()
            let calls = 0
            await cmd_prune( { flags: {} }, {
                input: { isTTY: true },
                output,
                ask: async () => answers.shift(),
                inspect_inventory: async () => inventory,
                recover_prunes: async () => ( { recovered: [], failed: [] } ),
                prune_clone: async options => {
                    calls++
                    return { pruned: true, clone_id: options.clone.clone_id }
                },
                now: () => now,
            } )
            expect( calls ).toBe( 1 )
        }

    } )

    it( `treats custom zero as all unused and tombstones fresh family records`, async () => {

        const { output } = output_collector()
        const unknown_age = { ...clone, last_used_at: null }
        const fresh_clone = {
            ...unknown_age,
            records: [
                ...unknown_age.records,
                { session: { babysit_id: `new-session` } },
            ],
        }
        const answers = [ `3`, `0`, `y` ]
        const inventory_calls = []

        await cmd_prune( { flags: {} }, {
            input: { isTTY: true },
            output,
            ask: async () => answers.shift(),
            inspect_inventory: async options => {
                inventory_calls.push( options )
                return inventory_calls.length === 1
                    ? { ...inventory, clones: [ unknown_age ] }
                    : { ...inventory, clones: [ fresh_clone ] }
            },
            recover_prunes: async () => ( { recovered: [], failed: [] } ),
            prune_clone: async options => {
                const validation = await options.revalidate( options.clone )
                expect( validation.session_ids ).toEqual( [ `old-session`, `new-session` ] )
                return { pruned: true, clone_id: options.clone.clone_id }
            },
            now: () => now,
        } )

        expect( inventory_calls[1].clone_ids ).toEqual( [ `old-clone` ] )

    } )

    it( `fails closed without a terminal and cancels on the default no`, async () => {

        const { output } = output_collector()
        let calls = 0
        await expect( cmd_prune( { flags: {} }, {
            input: { isTTY: false },
            output,
            inspect_inventory: async () => inventory,
            prune_clone: async () => { calls++ },
        } ) ).rejects.toThrow( `requires an interactive terminal` )

        const answers = [ ``, `` ]
        await cmd_prune( { flags: {} }, {
            input: { isTTY: true },
            output,
            ask: async () => answers.shift(),
            inspect_inventory: async () => inventory,
            recover_prunes: async () => ( { recovered: [], failed: [] } ),
            prune_clone: async () => { calls++ },
            now: () => now,
        } )

        expect( calls ).toBe( 0 )

    } )

    it( `distinguishes an absent tmux server from an unsafe inspection failure`, async () => {
        expect( await list_sessions( {
            strict: true,
            run_command: async () => { throw new Error( `tmux exited with code 1: no server running` ) },
        } ) ).toEqual( [] )
        expect( await list_sessions( {
            strict: true,
            run_command: async () => { throw new Error( `error connecting to /tmp/tmux-1000/babysit (No such file or directory)` ) },
        } ) ).toEqual( [] )

        await expect( list_sessions( {
            strict: true,
            run_command: async () => { throw new Error( `tmux permission denied` ) },
        } ) ).rejects.toThrow( `permission denied` )

        expect( await list_sessions( {
            run_command: async () => { throw new Error( `tmux permission denied` ) },
        } ) ).toEqual( [] )
    } )

} )
