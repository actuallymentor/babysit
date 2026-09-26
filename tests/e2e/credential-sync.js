import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { setup_linux_credentials } from '../../src/credentials/linux.js'
import { setup_darwin_credentials } from '../../src/credentials/darwin.js'
import { create_docker_file_transport } from '../../src/docker/file_transport.js'

// Real host watchers and Docker copies, isolated from all user credentials.
// This tests propagation, not the Codex process's OAuth recovery behavior.
const root = mkdtempSync( join( tmpdir(), `babysit-credential-watch-e2e-` ) )
const host = join( root, `auth.json` )
const target = `/tmp/credential-watch/auth.json`
const image = process.env.CREDENTIAL_SYNC_E2E_IMAGE || `babysit:e2e-fake`
const exec_file = promisify( execFile )
const docker = async args => ( await exec_file( `docker`, args, { timeout: 60_000 } ) ).stdout.trim()
const original = `{"tokens":{"access_token":"dummy-original"}}`
const renewed = `{"tokens":{"access_token":"dummy-renewed"}}`
const adapter = {
    name: `codex`,
    credentials: { linux: { file: host }, darwin: { file: host } },
    container_paths: { creds: target },
}
const replace_host = content => {
    const replacement = join( root, `replacement.json` )
    writeFileSync( replacement, content )
    renameSync( replacement, host )
}
const until_container = async expected => {
    const deadline = Date.now() + 15_000
    while( Date.now() < deadline ) {
        if( await docker( [ `exec`, container, `cat`, target ] ) === expected ) return
        await delay( 100 )
    }
    throw new Error( `Host login did not reach the running container` )
}
let container
let credentials

try {
    container = await docker( [
        `run`, `-d`, `--network`, `none`, `--entrypoint`, `/bin/sh`,
        image, `-c`, `sleep 180`,
    ] )
    await docker( [ `exec`, container, `mkdir`, `-p`, `/tmp/credential-watch` ] )

    for( const setup of [ setup_linux_credentials, setup_darwin_credentials ] ) {
        writeFileSync( host, original )
        credentials = await setup( adapter )
        const [ mount ] = credentials.mounts
        const transport = create_docker_file_transport( container, target )
        await transport.push( mount.source )
        credentials.sync.set_transport( transport )

        replace_host( renewed )
        await until_container( renewed )
        replace_host( original )
        await until_container( original )

        // A truncated login must neither reach Docker nor be overwritten by
        // the old container copy. Completing it should recover automatically.
        writeFileSync( host, `{"tokens":` )
        await delay( 500 )
        assert.equal( await docker( [ `exec`, container, `cat`, target ] ), original )
        assert.equal( readFileSync( host, `utf8` ), `{"tokens":` )
        replace_host( renewed )
        await until_container( renewed )

        // Container-originated refresh still reaches the host on reconciliation.
        await docker( [ `exec`, container, `sh`, `-c`, `printf '%s' '${ original }' > ${ target }` ] )
        await credentials.sync.flush()
        assert.equal( readFileSync( host, `utf8` ), original )

        // Distinguish real read errors from logout, which removes the file.
        unlinkSync( host )
        mkdirSync( host )
        await assert.rejects( credentials.sync.flush(), { code: `EISDIR` } )
        rmSync( host, { recursive: true } )
        await credentials.sync.stop()
        assert.equal( existsSync( host ), false )
        assert.equal( await docker( [ `inspect`, `--format`, `{{.State.Running}}`, container ] ), `true` )
        rmSync( credentials.cleanup_path, { recursive: true, force: true } )
        credentials = null
    }
    console.log( `Credential watcher Docker smoke passed for Linux and macOS adapters` )
} finally {
    // All files contain dummy tokens; cleanup is safe even after a failed test.
    if( credentials ) {
        await credentials.sync.stop().catch( () => {} )
        rmSync( credentials.cleanup_path, { recursive: true, force: true } )
    }
    if( container ) await docker( [ `rm`, `-f`, container ] )
    rmSync( root, { recursive: true, force: true } )
}
