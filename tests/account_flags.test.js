import { describe, it, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse_args } from '../src/cli/parse.js'
import { cmd_restart } from '../src/cli/restart.js'
import { merge_resume_flags } from '../src/cli/resume.js'
import { ACCOUNT_ENV_BOOTSTRAP_PATH, build_docker_launch_plan } from '../src/docker/launch.js'
import { build_docker_command_args } from '../src/docker/run.js'
import { cleanup_ephemeral_credential_mounts } from '../src/credentials/index.js'
import { claude } from '../src/agents/claude.js'

const WORK = `sk-ant-oat01-work-token`

describe( `--account parsing`, () => {

    it( `is a Babysit flag on launches and resumes, never agent passthrough`, () => {
        expect( parse_args( [ `claude`, `--account`, `work`, `--model`, `opus` ] ) ).toMatchObject( { flags: { account: `work` }, passthrough: [ `--model`, `opus` ] } )
        expect( parse_args( [ `claude`, `--account=work` ] ) ).toMatchObject( { flags: { account: `work` }, passthrough: [] } )
        expect( parse_args( [ `resume`, `abc`, `--account`, `home` ] ) ).toMatchObject( { session_id: `abc`, flags: { account: `home` }, passthrough: [] } )
        expect( parse_args( [ `claude`, `resume`, `abc`, `--account`, `home` ] ) ).toMatchObject( { session_id: `abc`, flags: { account: `home` }, passthrough: [] } )
        expect( parse_args( [ `claude` ] ).flags.account ).toBe( false )
        expect( () => parse_args( [ `claude`, `--account=` ] ) ).toThrow( `--account requires` )
        expect( () => parse_args( [ `claude`, `--account`, `a`, `--account`, `b` ] ) ).toThrow( `only be provided once` )
    } )

    it( `restart takes --account and --continue`, () => {
        expect( parse_args( [ `restart`, `2`, `--force`, `--detach`, `--continue`, `--account`, `work` ] ) ).toMatchObject( {
            verb: `restart`, session_id: `2`, flags: { force: true, detach: true, continue_prompt: true, account: `work` },
        } )
        expect( parse_args( [ `restart`, `--account=work`, `2` ] ) ).toMatchObject( { session_id: `2`, flags: { account: `work`, continue_prompt: false } } )
        expect( () => parse_args( [ `restart`, `2`, `--bogus` ] ) ).toThrow( `Unknown restart argument` )
    } )

    it( `--account is refused where no single Claude session is meant`, () => {
        expect( () => parse_args( [ `restart`, `all`, `--account`, `work` ] ) ).toThrow( `--account applies to one Claude session` )
        expect( () => parse_args( [ `codex`, `--account`, `work` ] ) ).toThrow( `codex has none` )
    } )

    it( `auth accounts [remove <name>] and init --name`, () => {
        expect( parse_args( [ `auth`, `accounts` ] ) ).toMatchObject( { verb: `auth`, auth_verb: `accounts`, account_verb: null } )
        expect( parse_args( [ `auth`, `accounts`, `remove`, `work` ] ) ).toMatchObject( { account_verb: `remove`, account_name: `work` } )
        expect( () => parse_args( [ `auth`, `accounts`, `remove` ] ) ).toThrow( `Usage: babysit auth accounts remove` )
        expect( () => parse_args( [ `auth`, `accounts`, `add` ] ) ).toThrow( `Unknown auth accounts command` )
        expect( parse_args( [ `auth`, `init`, `--claude-token`, `--name`, `work` ] ) ).toMatchObject( { auth_verb: `init`, flags: { claude_token: true, name: `work` } } )
    } )

    it( `resume keeps an explicit account and otherwise lets the stored one stand`, () => {
        expect( merge_resume_flags( [ `yolo` ], { account: `work`, continue_prompt: true } ) ).toMatchObject( { yolo: true, account: `work`, continue_prompt: true } )
        expect( merge_resume_flags( [ `yolo` ], { account: false } ).account ).toBeUndefined()
    } )

    it( `restart hands the account and continue prompt to resume`, async () => {
        const resumed = []
        await cmd_restart( { session_id: `1`, flags: { force: true, account: `work`, continue_prompt: true } }, {
            select: async () => ( { babysit_id: `s1`, agent: `claude`, tmux_session: `t`, agent_session_id: `n1`, launch_spec: { args: [] } } ),
            close: async () => {},
            resume: async cmd => resumed.push( cmd.flags ),
            image_id: async () => null,
            print: () => {},
        } )
        expect( resumed ).toEqual( [ { account: `work`, continue_prompt: true } ] )
    } )

    it( `restart refuses --account for a non-Claude session before closing it`, async () => {
        let closed = false
        await expect( cmd_restart( { session_id: `1`, flags: { force: true, account: `work` } }, {
            select: async () => ( { babysit_id: `s1`, agent: `codex`, tmux_session: `t`, agent_session_id: `n1`, launch_spec: { args: [] } } ),
            close: async () => {
                closed = true
            },
            resume: async () => {},
            image_id: async () => null,
            print: () => {},
        } ) ).rejects.toThrow( `s1 is a codex session` )
        expect( closed ).toBe( false )
    } )

} )

describe( `account token transport`, () => {

    it( `stages the account token as a private copy, never a docker -e flag`, () => {

        const plan = build_docker_launch_plan( {
            agent: claude, workspace: `/tmp/empty`, mode: {}, agent_args: [],
            creds_mounts: [
                { type: `env`, key: `CLAUDE_CODE_OAUTH_TOKEN`, value: `sk-ant-oat01-rc` },
                { type: `account_env`, key: `CLAUDE_CODE_OAUTH_TOKEN`, value: WORK, account: `work` },
            ],
            extra_mounts: [], config: { isolate_dependencies: false }, extra_env: {}, modifiers: [],
            interactive: true, mount_workspace: false, include_agents_dir: false,
        } )

        try {
            const copy = plan.creds_mounts.find( mount => mount.target === ACCOUNT_ENV_BOOTSTRAP_PATH )
            expect( copy.type ).toBe( `copy` )
            expect( readFileSync( copy.source, `utf8` ) ).toBe( `CLAUDE_CODE_OAUTH_TOKEN=${ WORK }\n` )
            expect( plan.creds_mounts.some( mount => mount.type === `account_env` ) ).toBe( false )
            const chrome_seccomp_profile_path = fileURLToPath( new URL( `../src/docker/chrome-seccomp.json`, import.meta.url ) )
            const args = build_docker_command_args( { ...plan, chrome_seccomp_profile_path } ).join( ` ` )
            expect( args ).not.toContain( WORK )
            // The rc default keeps its existing route
            expect( args ).toContain( `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-rc` )
        } finally {
            cleanup_ephemeral_credential_mounts( plan.creds_mounts )
        }

    } )

} )

// Run the real run_agent script from the entrypoint, with /home/node paths
// redirected to a temp home, so the test needs neither root nor Docker.
const run_agent_env = ( { rc = null, account = null } ) => {

    const home = mkdtempSync( join( tmpdir(), `babysit-account-entry-` ) )
    const source = readFileSync( new URL( `../src/docker/assets/entrypoint.sh`, import.meta.url ), `utf8` )
    const inner = source.match( /bash -c '\n([\s\S]*?)\n {4}' babysit-agent/ )[ 1 ]
        .replaceAll( `/home/node`, home )
        .replace( /^.*antigravity-auth\.py.*$/m, `` )

    if( rc !== null ) writeFileSync( join( home, `.babysitrc` ), rc )
    if( account !== null ) writeFileSync( join( home, `.babysit-claude-account.env` ), account )

    const result = spawnSync( `bash`, [ `-c`, inner, `babysit-agent`, `sh`, `-c`, `printf %s "$CLAUDE_CODE_OAUTH_TOKEN"; [ -e pwned ] && printf " pwned"` ], {
        cwd: home, env: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-bootstrap` }, encoding: `utf8`,
    } )
    return result.stdout

}

describe( `entrypoint account precedence`, () => {

    it( `the staged account file wins over ~/.babysitrc`, () => {
        expect( run_agent_env( { rc: `export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-rc\n`, account: `CLAUDE_CODE_OAUTH_TOKEN=${ WORK }\n` } ) ).toBe( WORK )
    } )

    it( `without an account file the rc and bootstrap behave as before`, () => {
        expect( run_agent_env( { rc: `export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-rc\n` } ) ).toBe( `sk-ant-oat01-rc` )
        expect( run_agent_env( {} ) ).toBe( `sk-ant-oat01-bootstrap` )
    } )

    it( `reads literal lines and never evaluates them`, () => {
        expect( run_agent_env( { account: `CLAUDE_CODE_OAUTH_TOKEN=$(touch pwned)` } ) ).toBe( `$(touch pwned)` )
    } )

} )
