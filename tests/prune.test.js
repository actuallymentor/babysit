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
import { plan_docker_prune, prune_unused_docker } from '../src/docker/prune.js'

const DAY_MS = 24 * 60 * 60 * 1_000

const output_collector = () => {

    let rendered = ``
    return {
        output: { write: chunk => { rendered += String( chunk ) } },
        rendered: () => rendered,
    }

}

describe( `Docker cleanup`, () => {

    it( `keeps recovery containers and pinned images while using the configured Docker prefix`, async () => {

        const directory = mkdtempSync( join( tmpdir(), `babysit-docker-prune-` ) )
        const calls = []

        try {
            save_session( {
                babysit_id: `held-session`,
                container_id: `held-id`,
                container_name: `held-name`,
                image_id: `sha256:held`,
                credentials_cleaned: false,
            }, { directory } )
            save_session( {
                babysit_id: `pruned-session`,
                image_id: `sha256:old`,
                clone_pruned_at: new Date().toISOString(),
            }, { directory } )

            const summary = await prune_unused_docker( {
                sessions_dir: directory,
                command_prefix: [ `sudo`, `docker` ],
                run_command: async ( command, args ) => {
                    calls.push( [ command, ...args ] )
                    if( args[1] === `container` && args[2] === `ls` && args.includes( `--quiet` ) ) return `held-id\nexternal-id\nother-id\nforeign-id\nanon-id\nrunning-id`
                    if( args[1] === `container` && args[2] === `ls` ) return [
                        `held-id\theld-name\tactuallymentor/babysit:2.0.0`,
                        `external-id\tbabysit-external\tactuallymentor/babysit:2.0.0`,
                        `other-id\tother-name\tactuallymentor/babysit:2.0.0`,
                        // Other projects' leftovers on the shared daemon, and a container whose image has no name
                        `foreign-id\tforeign-name\tpostgres:16`,
                        `anon-id\tanon-name\tsha256:abc`,
                    ].join( `\n` )
                    if( args[1] === `container` && args[2] === `inspect` ) return `sha256:held\nsha256:held\nsha256:pg\nsha256:anon\nsha256:busy`
                    if( args[1] === `image` && args[2] === `ls` ) return [
                        `sha256:held\t1GB\tactuallymentor/babysit\t2.0.0`,
                        `sha256:other\t2GB\tactuallymentor/babysit\t1.9.0`,
                        `sha256:old\t512MB\tactuallymentor/babysit\t1.0.0`,
                        `sha256:busy\t4GB\tactuallymentor/babysit-web\t1.0.0`,
                        `sha256:other\t2GB\tactuallymentor/babysit\tlatest`,
                        // Not Babysit's: another project's image, a dangling layer, the current image
                        `sha256:pg\t400MB\tpostgres\t16`,
                        `sha256:dangling\t90MB\t<none>\t<none>`,
                        `sha256:current\t3GB\tactuallymentor/babysit\tlatest`,
                    ].join( `\n` )
                    return ``
                },
            } )

            expect( calls.every( call => call[0] === `sudo` && call[1] === `docker` ) ).toBe( true )
            expect( calls.map( call => call.slice( 2, 4 ) ) ).toEqual( [
                [ `container`, `ls` ], [ `image`, `ls` ], [ `container`, `ls` ], [ `container`, `inspect` ], [ `buildx`, `du` ],
                [ `container`, `rm` ], [ `image`, `rm` ], [ `builder`, `prune` ],
            ] )
            // Babysit creates no networks, so an unused one is someone else's
            expect( calls.some( call => call[2] === `network` ) ).toBe( false )
            // The container being removed no longer pins its image; running ones do
            expect( calls.find( call => call[3] === `inspect` ).slice( 6 ) ).toEqual( [ `held-id`, `external-id`, `foreign-id`, `anon-id`, `running-id` ] )
            expect( calls.find( call => call[2] === `container` && call[3] === `rm` )[4] ).toBe( `other-id` )
            // `other` has two tags, which `image rm <id>` refuses: never planned
            expect( calls.filter( call => call[2] === `image` && call[3] === `rm` ).map( call => call[4] ) ).toEqual( [ `sha256:old` ] )
            expect( calls.find( call => call[4] === `external-id` ) ).toBeUndefined()
            // Other projects' stopped containers and images are never removed
            expect( calls.filter( call => call[3] === `rm` ).map( call => call[4] ).sort() ).toEqual( [ `other-id`, `sha256:old` ] )
            expect( summary ).toContain( `removed 1 stopped Babysit containers and 1 Babysit images` )
            expect( summary ).toContain( `networks and volumes untouched` )
        } finally {
            rmSync( directory, { recursive: true, force: true } )
        }

    } )

    it( `plans without deleting: only Babysit's images nothing still uses, counted once`, async () => {

        const directory = mkdtempSync( join( tmpdir(), `babysit-docker-plan-` ) )
        const calls = []

        try {
            const plan = await plan_docker_prune( {
                sessions_dir: directory,
                command_prefix: [ `docker` ],
                run_command: async ( command, args ) => {
                    calls.push( args.slice( 0, 2 ) )
                    if( args[0] === `container` && args.includes( `--quiet` ) ) return `stopped-id\nrunning-id`
                    if( args[0] === `container` && args[1] === `ls` ) return `stopped-id\tstopped\tactuallymentor/babysit:2.0.0\nother-id\tpg\tpostgres:16`
                    if( args[0] === `container` ) return `sha256:busy`
                    if( args[0] === `image` ) return [
                        `sha256:free\t2GB\tactuallymentor/babysit\t1.0.0`,
                        `sha256:tagged\t8GB\tactuallymentor/babysit\t1.1.0`,
                        `sha256:tagged\t8GB\tactuallymentor/babysit\tlatest`,
                        `sha256:busy\t4GB\tactuallymentor/babysit-web\t1.0.0`,
                        `sha256:foreign\t6GB\tpostgres\t16`,
                    ].join( `\n` )
                    return `x  true  3GB  9 days ago\ny  true  1GB*  9 days ago\nTotal: 5GB`
                },
                shared_sizes: async () => new Map( [ [ `sha256:free`, 1.5e9 ], [ `sha256:busy`, 1.5e9 ] ] ),
            } )

            expect( plan ).toEqual( {
                containers: [ { id: `stopped-id`, name: `stopped` } ],
                images: [ { id: `sha256:free`, bytes: 2e9 } ],
                image_bytes: 2e9,
                image_unique_bytes: 0.5e9,
                build_cache_bytes: 4e9,
                build_cache_private_bytes: 3e9,
                build_cache_total_bytes: 5e9,
            } )
            expect( calls.some( ( [ , verb ] ) => verb === `rm` || verb === `prune` ) ).toBe( false )
        } finally {
            rmSync( directory, { recursive: true, force: true } )
        }

    } )

    it( `keeps the current image and treats the BABYSIT_DOCKER_IMAGE repository and local babysit builds as its own`, async () => {

        const directory = mkdtempSync( join( tmpdir(), `babysit-docker-current-` ) )
        const before = process.env.BABYSIT_DOCKER_IMAGE
        process.env.BABYSIT_DOCKER_IMAGE = `registry.local/babysit:dev`

        try {
            const plan = await plan_docker_prune( {
                sessions_dir: directory,
                command_prefix: [ `docker` ],
                measure_cache: async () => null,
                shared_sizes: async () => null,
                run_command: async ( command, args ) => {
                    if( args[0] === `container` ) return ``
                    return [
                        `sha256:current\t1GB\tregistry.local/babysit\tdev`,
                        `sha256:older\t1GB\tregistry.local/babysit\t0.9`,
                        `sha256:e2e\t1GB\tbabysit\te2e-base`,
                        `sha256:lookalike\t1GB\tsomeone/babysit-fork\tlatest`,
                    ].join( `\n` )
                },
            } )
            expect( plan.images.map( image => image.id ).sort() ).toEqual( [ `sha256:e2e`, `sha256:older` ] )
        } finally {
            if( before === undefined ) delete process.env.BABYSIT_DOCKER_IMAGE
            else process.env.BABYSIT_DOCKER_IMAGE = before
            rmSync( directory, { recursive: true, force: true } )
        }

    } )

    it( `re-reads saved sessions before deleting, so a waiting plan cannot remove what was saved since`, async () => {

        const directory = mkdtempSync( join( tmpdir(), `babysit-docker-stale-` ) )
        const removed = []

        try {
            const plan = {
                containers: [ { id: `c-old`, name: `old` }, { id: `c-new`, name: `new` } ],
                images: [ { id: `sha256:old`, bytes: 1 }, { id: `sha256:new`, bytes: 1 } ],
            }
            // Saved while prune waited for the y/N answer
            save_session( { babysit_id: `late`, container_id: `c-new`, image_id: `sha256:new` }, { directory } )

            await prune_unused_docker( {
                plan,
                sessions_dir: directory,
                command_prefix: [ `docker` ],
                run_command: async ( command, args ) => {
                    if( args[1] === `rm` ) removed.push( args[2] )
                    return ``
                },
            } )

            expect( removed ).toEqual( [ `c-old`, `sha256:old` ] )
        } finally {
            rmSync( directory, { recursive: true, force: true } )
        }

    } )

    it( `aborts before deletion when session records or Docker listings are unreadable`, async () => {

        const directory = mkdtempSync( join( tmpdir(), `babysit-docker-prune-` ) )
        const calls = []
        const run_command = async ( command, args ) => {
            calls.push( args.slice( 0, 2 ) )
            if( args[0] === `container` ) return `malformed-row`
            return `sha256:unused`
        }

        try {
            writeFileSync( join( directory, `bad.json` ), `{` )
            await expect( prune_unused_docker( { sessions_dir: directory, run_command, command_prefix: [ `docker` ] } ) )
                .rejects.toThrow( `Session registry unreadable` )
            expect( calls ).toEqual( [] )

            unlinkSync( join( directory, `bad.json` ) )
            await expect( prune_unused_docker( { sessions_dir: directory, run_command, command_prefix: [ `docker` ] } ) )
                .rejects.toThrow( `Docker container listing unreadable` )
            expect( calls ).toEqual( [ [ `container`, `ls` ], [ `image`, `ls` ] ] )
        } finally {
            rmSync( directory, { recursive: true, force: true } )
        }

    } )

} )

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

    it( `protects archived sessions after all runtime state disappears`, async () => {

        const clone = create_clone()
        save_session( {
            babysit_id: `archived-gone`,
            clone_id: clone.clone_id,
            clone_path: clone.workspace,
            status: `exited`,
            archived_at: `2026-11-01T10:00:00.000Z`,
        }, { directory: sessions_dir } )
        const inventory = await inspect_clone_inventory( {
            clones_dir,
            sessions_dir,
            list_tmux: async () => [],
            monitor_alive: () => false,
            inspect_container: async () => null,
            get_cwd: () => directory,
        } )
        expect( inventory.clones[0].status ).toBe( `protected: archived` )
        expect( inventory.clones[0].available ).toBe( false )

    } )

    it( `protects expected-open recovery families after all runtime state disappears`, async () => {

        const clone = create_clone()
        save_session( {
            babysit_id: `recovery-launch`,
            clone_id: clone.clone_id,
            clone_path: clone.workspace,
            status: `failed`,
            expected_open: true,
            recovery_version: 1,
        }, { directory: sessions_dir } )
        const inventory = await inspect_clone_inventory( {
            clones_dir,
            sessions_dir,
            list_tmux: async () => [],
            monitor_alive: () => false,
            inspect_container: async () => null,
            get_cwd: () => directory,
        } )
        expect( inventory.clones[0].status ).toBe( `protected: recovery pending` )
        expect( inventory.clones[0].available ).toBe( false )

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

    it( `falls back to root removal for foreign-owned quarantine and reports when that fails`, async () => {

        const clone = create_clone()
        const [ managed ] = list_managed_clones( { clones_dir } ).clones
        const root_calls = []
        const result = await prune_managed_clone( {
            clone: managed,
            session_ids: [],
            clones_dir,
            mark_sessions: async () => {},
            revalidate: async () => ( {} ),
            remove_as_root: async path => root_calls.push( path ),
        } )
        expect( result.pruned ).toBe( true )
        // Owned tree: rm succeeds directly, root helper never consulted
        expect( root_calls ).toEqual( [] )
        expect( existsSync( clone.clone_path ) ).toBe( false )

    } )

    it( `reports a root-owned quarantine with a sudo hint when root removal fails`, async () => {

        const sudo = spawnSync( `sudo`, [ `-n`, `true` ] )
        if( sudo.status !== 0 ) return // needs passwordless sudo to plant a root-owned file

        const clone = create_clone()
        const [ managed ] = list_managed_clones( { clones_dir } ).clones
        const root_dir = join( clone.clone_path, `artifacts` )
        mkdirSync( root_dir )
        expect( spawnSync( `sudo`, [ `-n`, `sh`, `-c`, `touch '${ root_dir }/gpu' && chmod 700 '${ root_dir }' && chown root:root '${ root_dir }' '${ root_dir }/gpu'` ] ).status ).toBe( 0 )

        try {
            const root_calls = []
            await expect( prune_managed_clone( {
                clone: managed,
                session_ids: [],
                clones_dir,
                mark_sessions: async () => {},
                revalidate: async () => ( {} ),
                remove_as_root: async path => {
                    root_calls.push( path )
                    throw new Error( `no docker` )
                },
            } ) ).rejects.toMatchObject( { code: `EFOREIGN` } )
            expect( root_calls.length ).toBe( 1 )
            expect( root_calls[0] ).toContain( `/trash/` )

            // The journal stays, so the next run retries; a working root remover finishes it
            const recovery = await recover_prune_operations( {
                clones_dir,
                mark_sessions: async () => {},
                remove_as_root: async path => {
                    expect( spawnSync( `sudo`, [ `-n`, `rm`, `-rf`, path ] ).status ).toBe( 0 )
                },
            } )
            expect( recovery.recovered ).toEqual( [ managed.clone_id ] )
            expect( recovery.failed ).toEqual( [] )
        } finally {
            spawnSync( `sudo`, [ `-n`, `rm`, `-rf`, clone.clone_path, join( clones_dir, `.babysit-state`, `trash` ) ] )
        }

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

    // Spawns the whole CLI; a busy CI runner needs ~7s just to load it
    }, 20_000 )

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

    // Nothing to reclaim from Docker, and no real daemon or disk is consulted
    const docker_plan = { containers: [], images: [], image_bytes: 0, build_cache_bytes: 0, build_cache_total_bytes: 0 }
    const offline = {
        plan_docker: async () => docker_plan,
        measure_directory: async () => 0,
        read_health: () => ( {} ),
        find_root_dir: async () => null,
        clones_dir: `/tmp/clones`,
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
            ...offline,
            inspect_inventory: async () => inventory,
            now: () => now,
        } )

        expect( rendered() ).toContain( `1 clone currently in /tmp/clones` )
        expect( rendered() ).toContain( `2.0 kB` )
        expect( rendered() ).toContain( `/tmp/clones/old-clone` )

    } )

    it( `shows where reclaimable space is before asking, and sizes every question`, async () => {

        const { output, rendered } = output_collector()
        const prompts = []
        const answers = [ `n`, ``, `` ]
        await cmd_prune( { flags: {} }, {
            input: { isTTY: true },
            output,
            ask: async prompt => ( prompts.push( prompt ), answers.shift() ),
            ...offline,
            plan_docker: async () => ( {
                containers: [ { id: `c1`, name: `old` } ],
                images: [ { id: `sha256:a`, bytes: 9e9 } ],
                image_bytes: 9e9,
                image_unique_bytes: 3e9,
                build_cache_bytes: 180e9,
                build_cache_private_bytes: 100e9,
                build_cache_total_bytes: 240e9,
            } ),
            measure_directory: async () => 6e9,
            clones_dir: `/tmp/clones`,
            inspect_inventory: async () => ( { ...inventory, pending_prunes: [ `/tmp/clones/.babysit-state/prune-journals/x.json` ] } ),
            recover_prunes: async () => ( { recovered: [], failed: [] } ),
            prune_clone: async () => ( { pruned: false, reason: `kept` } ),
            now: () => now,
        } )

        const text = rendered()
        expect( text ).toMatch( /Docker build cache unused 7\+ days\s+100 GB to 180 GB of 240 GB/ )
        expect( text ).toMatch( /Babysit Docker images, 1 unused\s+3.0 GB to 9.0 GB/ )
        expect( text ).toMatch( /Clones unused 30\+ days\s+1 clone, 2.0 kB/ )
        expect( text ).toMatch( /Interrupted prune leftovers\s+6.0 GB/ )
        expect( text ).toContain( `1. Unused for 30 days (default): 1 clone, 2.0 kB` )
        expect( prompts[0] ).toContain( `103 GB to 189 GB` )
        // Nothing was deleted, so nothing claims to be freed
        expect( text ).not.toContain( `Freed` )

    } )

    it( `skips Docker cleanup when it cannot be planned, and reports space actually freed`, async () => {

        const { output, rendered } = output_collector()
        const answers = [ `2`, `yes` ]
        let free_bytes = 100e9
        let docker_calls = 0
        await cmd_prune( { flags: {} }, {
            input: { isTTY: true },
            output,
            ask: async () => answers.shift(),
            ...offline,
            clones_dir: `/tmp/clones`,
            plan_docker: async () => {
                throw new Error( `daemon unreachable` )
            },
            prune_docker: async () => {
                docker_calls++
            },
            disk_seams: {
                stat: () => ( { dev: 3 } ),
                statfs: () => ( { bsize: 1, blocks: 1e12, bavail: free_bytes, type: 0x2fc12fc1 } ),
            },
            inspect_inventory: async () => inventory,
            recover_prunes: async () => ( { recovered: [], failed: [] } ),
            prune_clone: async () => {
                free_bytes += 12e9
                return { pruned: true }
            },
            now: () => now,
        } )

        const text = rendered()
        expect( docker_calls ).toBe( 0 )
        expect( text ).toMatch( /Docker\s+unavailable: daemon unreachable/ )
        expect( text ).toContain( `Skipping Docker cleanup: daemon unreachable` )
        expect( text ).toContain( `Disk holding /tmp/clones: 900 GB of 1.0 TB used, 100 GB free.` )
        expect( text ).toContain( `Freed 12 GB on the disk holding /tmp/clones (ZFS frees space in the background; more may follow).` )

    } )

    it( `prints the sudo hint for a foreign-owned quarantine and continues`, async () => {

        const { output, rendered } = output_collector()
        const error = Object.assign( new Error( `boom` ), { code: `EFOREIGN`, path: `/clones/.babysit-state/trash/old-1` } )
        await cmd_prune( { flags: {} }, {
            input: { isTTY: true },
            output,
            ask: async () => `n`,
            ...offline,
            inspect_inventory: async () => ( { ...inventory, clones: [] } ),
            recover_prunes: async () => ( { recovered: [], failed: [ { path: `/j.json`, clone_id: `old`, error } ] } ),
            prune_docker: async () => ``,
        } )

        expect( rendered() ).toContain( `Skipping quarantined clone old` )
        expect( rendered() ).toContain( `sudo rm -rf /clones/.babysit-state/trash/old-1` )
        expect( rendered() ).toContain( `No clone workspaces found.` )

    } )

    it( `prunes Docker even when no clone workspaces exist`, async () => {

        const { output, rendered } = output_collector()
        let docker_calls = 0
        await cmd_prune( { flags: {} }, {
            input: { isTTY: true },
            output,
            ask: async () => `yes`,
            ...offline,
            inspect_inventory: async () => ( { ...inventory, clones: [] } ),
            recover_prunes: async () => ( { recovered: [], failed: [] } ),
            prune_docker: async () => {
                docker_calls++
                return `Total reclaimed space: 1GB`
            },
        } )

        expect( docker_calls ).toBe( 1 )
        expect( rendered() ).toContain( `Total reclaimed space: 1GB` )
        expect( rendered() ).toContain( `No clone workspaces found.` )

    } )

    it( `skips Docker on no and reports Docker failures without blocking clone selection`, async () => {

        const { output, rendered } = output_collector()
        const answer_sets = [ [ `n`, ``, `` ], [ `y`, `2`, `yes` ] ]
        let docker_calls = 0
        let clone_calls = 0

        for( const answers of answer_sets ) {
            await cmd_prune( { flags: {} }, {
                input: { isTTY: true },
                output,
                ask: async () => answers.shift(),
                ...offline,
                inspect_inventory: async () => inventory,
                recover_prunes: async () => ( { recovered: [], failed: [] } ),
                prune_docker: async () => {
                    docker_calls++
                    throw new Error( `Docker unavailable` )
                },
                prune_clone: async () => {
                    clone_calls++
                    return { pruned: true }
                },
                now: () => now,
            } )
        }

        expect( docker_calls ).toBe( 1 )
        expect( clone_calls ).toBe( 1 )
        expect( rendered() ).toContain( `Could not prune Docker: Docker unavailable` )

    } )

    it( `uses the 30-day default and requires explicit final confirmation`, async () => {

        const { output, rendered } = output_collector()
        const answers = [ ``, ``, `yes` ]
        const pruned = []
        await cmd_prune( { flags: {} }, {
            input: { isTTY: true },
            output,
            ask: async () => answers.shift(),
            ...offline,
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

        for( const answers of [ [ ``, `2`, `y` ], [ ``, `3`, `invalid`, `0`, `y` ] ] ) {
            const { output } = output_collector()
            let calls = 0
            await cmd_prune( { flags: {} }, {
                input: { isTTY: true },
                output,
                ask: async () => answers.shift(),
                ...offline,
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
        const answers = [ ``, `3`, `0`, `y` ]
        const inventory_calls = []

        await cmd_prune( { flags: {} }, {
            input: { isTTY: true },
            output,
            ask: async () => answers.shift(),
            ...offline,
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
            ...offline,
            inspect_inventory: async () => inventory,
            prune_clone: async () => { calls++ },
        } ) ).rejects.toThrow( `requires an interactive terminal` )

        const answers = [ ``, ``, `` ]
        await cmd_prune( { flags: {} }, {
            input: { isTTY: true },
            output,
            ask: async () => answers.shift(),
            ...offline,
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
