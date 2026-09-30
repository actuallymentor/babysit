import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
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
    mkdirSync( join( source, `nested` ) )
    linkSync( join( source, `payload.txt` ), join( source, `nested`, `linked.txt` ) )
    execFileSync( `python3`, [ `-c`, `import os,sys; p=sys.argv[1]; os.setxattr(p, 'user.babysit', b'kept'); os.utime(p, ns=(1700000000123456789,1700000000123456789))`, join( source, `payload.txt` ) ] )
    const clone = prepare_clone_workspace( { source, clones_dir, clone_id: `disk-full` } )
    const paths = clone_state_paths( clones_dir )
    assert.equal( statSync( join( clone.workspace, `payload.txt` ) ).ino, statSync( join( clone.workspace, `nested`, `linked.txt` ) ).ino )
    assert.notEqual( statSync( join( source, `payload.txt` ) ).ino, statSync( join( clone.workspace, `payload.txt` ) ).ino )
    execFileSync( `python3`, [ `-c`, `import os,sys; p=sys.argv[1]; assert os.getxattr(p, 'user.babysit') == b'kept'; assert os.stat(p).st_mtime_ns == 1700000000123456789`, join( clone.workspace, `payload.txt` ) ] )
    console.log( `PASS compiled Bun clone preserves hard links, xattrs and nanosecond mtime` )

    // Bun caches command resolution after the first copy. Remove only this
    // disposable container's executable, restoring it before storage checks.
    const rsync_binary = `/usr/bin/rsync`
    const hidden_rsync = `/usr/bin/rsync.babysit-storage-test`
    renameSync( rsync_binary, hidden_rsync )
    try {
        assert.throws( () => prepare_clone_workspace( { source, clones_dir, clone_id: `missing-rsync` } ), /Linux clone creation requires rsync/ )
        assert.equal( existsSync( join( clones_dir, `missing-rsync` ) ), false )
        assert.equal( existsSync( join( paths.manifests, `missing-rsync.json` ) ), false )
        assert.deepEqual( readdirSync( paths.partials ), [] )
        assert.deepEqual( readdirSync( paths.locks ), [] )
        assert.equal( prepare_clone_workspace( { source, clones_dir, clone_id: `disk-full` } ).reused, true )
        console.log( `PASS compiled Bun missing-rsync failure cleans state; completed clone reuse needs no rsync` )
    } finally {
        renameSync( hidden_rsync, rsync_binary )
    }

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

    const oversized = mkdtempSync( `/tmp/clone-oversized-` )
    try {
        writeFileSync( join( oversized, `large` ), Buffer.alloc( 2 * 1024 * 1024, 1 ) )
        assert.throws( () => prepare_clone_workspace( { source: oversized, clones_dir, clone_id: `copy-disk-full` } ), /rsync/i )
        assert.equal( existsSync( join( clones_dir, `copy-disk-full` ) ), false )
        assert.equal( existsSync( join( paths.manifests, `copy-disk-full.json` ) ), false )
        assert.deepEqual( readdirSync( paths.partials ), [] )
        assert.deepEqual( readdirSync( paths.locks ), [] )
        assert.equal( statSync( join( oversized, `large` ) ).size, 2 * 1024 * 1024 )
        console.log( `PASS real rsync ENOSPC never publishes a partial clone or stale ownership state` )
    } finally {
        rmSync( oversized, { recursive: true, force: true } )
    }

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
    const bundle = join( temporary, `clone-storage` )
    let container_id

    try {
        // Ship the production code and fixture together, without copying the
        // entire development dependency tree through a loaded Docker daemon.
        await run( `bun`, [ `build`, fileURLToPath( import.meta.url ), `--compile`, `--outfile`, bundle ], { timeout: 30_000 } )
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
        await docker( [ `cp`, bundle, `${ container_id }:/app/clone-storage` ] )
        const result = await docker( [ `exec`, container_id, `/app/clone-storage`, `--inside` ] )
        process.stdout.write( result.stdout )
    } finally {
        rmSync( temporary, { recursive: true, force: true } )
        if( container_id ) await docker( [ `rm`, `-f`, container_id ] )
    }

}

if( process.argv.includes( `--inside` ) ) await run_inside()
else await run_docker()
