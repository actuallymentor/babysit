import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const shim = new URL( `../src/docker/assets/claude-shim.sh`, import.meta.url ).pathname
let root

beforeEach( () => {

    root = mkdtempSync( join( tmpdir(), `babysit-shim-` ) )
    // The shim lives in its own dir; the "real" claude just reports what it received
    mkdirSync( join( root, `shim` ) )
    mkdirSync( join( root, `real` ) )
    writeFileSync( join( root, `shim`, `claude` ), readFileSync( shim ) )
    writeFileSync( join( root, `real`, `claude` ), `#!/bin/bash\necho "token=\${CLAUDE_CODE_OAUTH_TOKEN:-none} args=$*"\n` )
    chmodSync( join( root, `shim`, `claude` ), 0o755 )
    chmodSync( join( root, `real`, `claude` ), 0o755 )

} )

afterEach( () => rmSync( root, { recursive: true, force: true } ) )

const run = ( { env = {}, account = null, rc = null, args = [ `-p`, `hi` ] } = {} ) => {

    const { CLAUDE_CODE_OAUTH_TOKEN: _ambient, ...clean } = process.env
    if( account !== null ) writeFileSync( join( root, `account.env` ), account )
    if( rc !== null ) writeFileSync( join( root, `rc` ), rc )

    const result = spawnSync( join( root, `shim`, `claude` ), args, {
        encoding: `utf8`,
        env: {
            ...clean,
            PATH: `${ join( root, `shim` ) }:${ join( root, `real` ) }:${ process.env.PATH }`,
            BABYSIT_CLAUDE_ACCOUNT_ENV: join( root, `account.env` ),
            BABYSIT_CLAUDE_RC: join( root, `rc` ),
            ...env,
        },
    } )
    return { code: result.status, out: result.stdout.trim(), err: result.stderr.trim() }

}

describe( `claude shim`, () => {

    it( `loads the chosen account's token when the environment has none`, () => {
        expect( run( { account: `CLAUDE_CODE_OAUTH_TOKEN=account-token\n` } ).out ).toBe( `token=account-token args=-p hi` )
    } )

    it( `lets the account outrank a token already in the environment, like the agent launch`, () => {
        const { out } = run( { env: { CLAUDE_CODE_OAUTH_TOKEN: `rc-token` }, account: `CLAUDE_CODE_OAUTH_TOKEN=account-token\n` } )
        expect( out ).toBe( `token=account-token args=-p hi` )
    } )

    it( `falls back to the rc token for sessions without a named account`, () => {
        expect( run( { rc: `export CLAUDE_CODE_OAUTH_TOKEN=rc-token\nexport OTHER=leaked\n` } ).out ).toBe( `token=rc-token args=-p hi` )
        // An existing token is left alone, and the rc is not even read
        expect( run( { env: { CLAUDE_CODE_OAUTH_TOKEN: `kept` }, rc: `exit 3\n` } ).out ).toBe( `token=kept args=-p hi` )
    } )

    it( `reads the account file as data, never as shell`, () => {
        const marker = join( root, `ran` )
        const { out } = run( { account: `CLAUDE_CODE_OAUTH_TOKEN=a b $(touch ${ marker })\n\n` } )
        expect( out ).toBe( `token=a b $(touch ${ marker }) args=-p hi` )
        expect( () => readFileSync( marker ) ).toThrow()
    } )

    it( `ignores a broken rc and passes arguments through untouched`, () => {
        const { out } = run( { rc: `this is not shell (\n`, args: [ `--model`, `a b`, `--`, `-x` ] } )
        expect( out ).toBe( `token=none args=--model a b -- -x` )
    } )

    it( `chains through another copy of itself without looping`, () => {
        // The image shim first on PATH, a hot-fixed copy in a shared volume second
        mkdirSync( join( root, `volume` ) )
        writeFileSync( join( root, `volume`, `claude` ), readFileSync( shim ) )
        chmodSync( join( root, `volume`, `claude` ), 0o755 )
        const path = `${ join( root, `shim` ) }:${ join( root, `volume` ) }:${ join( root, `real` ) }:/usr/bin:/bin`
        expect( run( { env: { PATH: path }, account: `CLAUDE_CODE_OAUTH_TOKEN=account-token\n` } ).out ).toBe( `token=account-token args=-p hi` )

        // Entered at the second copy, it still only looks further along
        const second = spawnSync( join( root, `volume`, `claude` ), [ `-p` ], { encoding: `utf8`, env: { PATH: path, BABYSIT_CLAUDE_RC: `/nonexistent`, BABYSIT_CLAUDE_ACCOUNT_ENV: `/nonexistent` } } )
        expect( second.stdout.trim() ).toBe( `token=none args=-p` )
    } )

    it( `runs the next claude on PATH, not itself, and fails cleanly without one`, () => {
        expect( run().out ).toContain( `args=-p hi` )
        rmSync( join( root, `real`, `claude` ) )
        const missing = run( { env: { PATH: `${ join( root, `shim` ) }:/usr/bin:/bin` } } )
        expect( missing.code ).toBe( 127 )
        expect( missing.err ).toBe( `claude: not found on PATH` )
    } )

} )
