import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify( execFile )

const run_inside = async () => {

    assert.equal( process.env.BABYSIT_STORAGE_E2E, `isolated-tmpfs` )
    const { acquire_clone_lock, clone_lock_status, clone_state_paths, prepare_clone_workspace } = await import( `../../src/clone.js` )
    const { list_managed_clones, prune_managed_clone } = await import( `../../src/prune.js` )
    const clones_dir = `/scratch/clones`
    const source = `/scratch/source`
    mkdirSync( source )
    writeFileSync( join( source, `payload.txt` ), `source must survive pruning\n` )
    const clone = prepare_clone_workspace( { source, clones_dir, clone_id: `disk-full` } )
    const paths = clone_state_paths( clones_dir )

    // Fill only this disposable container's 1 MiB tmpfs. Real kernel ENOSPC
    // reproduces a successful open followed by a failed lock-owner write.
    const filler = `/scratch/filler`
    const fd = openSync( filler, `wx` )
    try {
        assert.throws( () => {
            while( true ) writeSync( fd, Buffer.alloc( 4_096, 1 ) )
        }, { code: `ENOSPC` } )
    } finally {
        closeSync( fd )
    }

    assert.throws( () => acquire_clone_lock( clone.workspace, { clones_dir } ), { code: `ENOSPC` } )
    assert.equal( clone_lock_status( clone.workspace, { clones_dir } ), `unlocked` )
    assert.deepEqual( readdirSync( paths.locks ), [], `failed writes must leave neither a published lock nor temporary owner records` )
    console.log( `PASS real ENOSPC preserves storage error and leaves no phantom clone lock` )

    rmSync( filler )
    const [ managed ] = list_managed_clones( { clones_dir } ).clones
    const result = await prune_managed_clone( {
        clone: managed, clones_dir, session_ids: [],
        revalidate: async () => null,
        mark_sessions: async () => {},
    } )
    assert.equal( result.pruned, true )
    assert.equal( existsSync( clone.workspace ), false )
    assert.ok( existsSync( join( source, `payload.txt` ) ) )
    console.log( `PASS prune succeeds after space is freed without manual lock cleanup` )

}

const run_docker = async () => {

    let command = `docker`
    let prefix = []
    try {
        await run( command, [ `info` ], { timeout: 30_000 } )
    } catch {
        command = `sudo`
        prefix = [ `-n`, `docker` ]
        await run( command, [ ...prefix, `info` ], { timeout: 30_000 } )
    }
    const docker = args => run( command, [ ...prefix, ...args ], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 } )
    const image = process.env.BABYSIT_E2E_BASE_IMAGE || `actuallymentor/babysit:latest`
    const { stdout: image_id } = await docker( [ `image`, `inspect`, image, `--format`, `{{.Id}}` ] )
    const temporary = mkdtempSync( join( tmpdir(), `babysit-storage-bundle-` ) )
    const bundle = join( temporary, `clone-storage.mjs` )
    let container_id

    try {
        // Ship the production code and fixture together, without copying the
        // entire development dependency tree through a loaded Docker daemon.
        await run( `bun`, [ `build`, fileURLToPath( import.meta.url ), `--target=node`, `--outfile`, bundle ], { timeout: 30_000 } )
        // Copy into an owned container; no host mounts, daemon socket, or user
        // credentials enter the fixture. Pin the existing image, avoiding pulls.
        const { stdout } = await docker( [
            `create`, `--name`, `babysit-storage-e2e-${ process.pid }-${ Date.now() }`,
            `--user`, `0`, `--entrypoint`, `sleep`, `--workdir`, `/app`,
            `--tmpfs`, `/scratch:rw,size=1m`, `--env`, `BABYSIT_STORAGE_E2E=isolated-tmpfs`,
            image_id.trim(), `infinity`,
        ] )
        container_id = stdout.trim()
        await docker( [ `start`, container_id ] )
        await docker( [ `cp`, bundle, `${ container_id }:/app/clone-storage.mjs` ] )
        const result = await docker( [ `exec`, container_id, `node`, `clone-storage.mjs`, `--inside` ] )
        process.stdout.write( result.stdout )
    } finally {
        rmSync( temporary, { recursive: true, force: true } )
        if( container_id ) await docker( [ `rm`, `-f`, container_id ] )
    }

}

if( process.argv.includes( `--inside` ) ) await run_inside()
else await run_docker()
