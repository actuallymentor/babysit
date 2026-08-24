#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'

import { SUPPORTED_AGENTS } from '../../src/agents/index.js'
import { ensure_chrome_seccomp_profile } from '../../src/docker/chrome-seccomp.js'

const repo_root = resolve( fileURLToPath( new URL( `../../`, import.meta.url ) ) )
const run_id = `babysit-e2e-${ Date.now() }-${ Math.random().toString( 16 ).slice( 2, 8 ) }`
const tmux_socket = run_id
const base_image = process.env.BABYSIT_E2E_BASE_IMAGE || `babysit:e2e-base`
const fake_image = process.env.BABYSIT_E2E_FAKE_IMAGE || `babysit:e2e-fake`
const root = await mkdtemp( join( repo_root, `.babysit-e2e-${ run_id }-` ) )
const state_root = await mkdtemp( join( tmpdir(), `${ run_id }-` ) )
const browser_seccomp_profile = ensure_chrome_seccomp_profile( {
    path: join( state_root, `chrome-seccomp.json` ),
} )
const home = join( state_root, `home` )
const host_bin = join( state_root, `bin` )
const workspaces_root = join( root, `workspaces` )
const workspace_tmp = join( root, `tmp` )
const docker_without_sudo = await command_ok( `docker`, [ `info` ] )
const docker_with_sudo = docker_without_sudo ? false : await command_ok( `sudo`, [ `docker`, `info` ] )
const use_sudo_docker = !docker_without_sudo && docker_with_sudo

mkdirSync( home, { recursive: true } )
mkdirSync( host_bin, { recursive: true } )
mkdirSync( workspaces_root, { recursive: true } )
mkdirSync( workspace_tmp, { recursive: true } )
mkdirSync( join( home, `.claude` ), { recursive: true } )
mkdirSync( join( home, `.codex` ), { recursive: true } )
mkdirSync( join( home, `.gemini` ), { recursive: true } )
mkdirSync( join( home, `.local/share/opencode` ), { recursive: true } )
writeFileSync( join( home, `.claude/.credentials.json` ), JSON.stringify( { refresh_token: `e2e-claude-token` } ) )
writeFileSync( join( home, `.codex/auth.json` ), JSON.stringify( { refresh_token: `e2e-original-token` } ) )
writeFileSync( join( home, `.gemini/oauth_creds.json` ), JSON.stringify( { refresh_token: `e2e-gemini-token` } ) )
writeFileSync( join( home, `.local/share/opencode/auth.json` ), JSON.stringify( { refresh_token: `e2e-opencode-token` } ) )

for( const agent of SUPPORTED_AGENTS ) {
    symlinkSync( join( repo_root, `tests/e2e/assets/fake-agent.mjs` ), join( host_bin, agent ) )
}

const docker = async ( args, options = {} ) => {
    if( use_sudo_docker ) return run( `sudo`, [ `docker`, ...args ], options )
    return run( `docker`, args, options )
}

const tmux = ( args, options = {} ) => run( `tmux`, [ `-L`, tmux_socket, ...args ], options )

const e2e_env = () => {
    // The test image has no host profile. Do not inherit an enclosing
    // Babysit session's carried host path: it is intentionally unreadable in
    // this synthetic HOME, which correctly disables production auth caching
    // but would make every E2E launch repeat all four verified probes.
    const host_env = { ...process.env }
    delete host_env.BABYSIT_HOST_BABYSITRC
    const env = {
        ...host_env,
        HOME: home,
        TMPDIR: workspace_tmp,
        CODEX_HOME: join( home, `.codex` ),
        PATH: `${ host_bin }:${ process.env.PATH }`,
        AGENT_AUTONOMY_MODE: `yolo`,
        BABYSIT_TMUX_SOCKET: tmux_socket,
        BABYSIT_DOCKER_IMAGE: fake_image,
        BABYSIT_E2E_RUN_ID: run_id,
        BABYSIT_E2E_SIBLING_IMAGE: fake_image,
        LOG_LEVEL: process.env.LOG_LEVEL || `info`,
    }

    if( use_sudo_docker ) env.BABYSIT_DOCKER_USE_SUDO = `1`

    return env
}

/**
 * Run a command and capture its output.
 * @param {string} cmd - Executable
 * @param {string[]} [args=[]] - Arguments
 * @param {Object} [options={}] - Spawn options
 * @param {number} [options.timeout_ms=120000] - Timeout
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function run( cmd, args = [], options = {} ) {

    const { timeout_ms = 120_000, ...spawn_options } = options

    return new Promise( ( resolve_run, reject_run ) => {

        const child = spawn( cmd, args, {
            cwd: repo_root,
            env: process.env,
            stdio: [ `ignore`, `pipe`, `pipe` ],
            ...spawn_options,
        } )

        let stdout = ``
        let stderr = ``
        const timer = setTimeout( () => {
            child.kill( `SIGTERM` )
            reject_run( new Error( [
                `Timed out after ${ timeout_ms }ms: ${ [ cmd, ...args ].join( ` ` ) }`,
                `STDOUT:`,
                stdout,
                `STDERR:`,
                stderr,
            ].join( `\n` ) ) )
        }, timeout_ms )

        child.stdout.on( `data`, chunk => stdout += chunk.toString() )
        child.stderr.on( `data`, chunk => stderr += chunk.toString() )
        child.on( `error`, error => {
            clearTimeout( timer )
            reject_run( error )
        } )
        child.on( `close`, code => {
            clearTimeout( timer )
            if( code === 0 ) return resolve_run( { stdout, stderr } )

            const command = [ cmd, ...args ].join( ` ` )
            reject_run( new Error( `${ command } exited ${ code }\nSTDOUT:\n${ stdout }\nSTDERR:\n${ stderr }` ) )
        } )

    } )

}

/**
 * Check whether a command succeeds.
 * @param {string} cmd - Executable
 * @param {string[]} args - Arguments
 * @returns {Promise<boolean>}
 */
async function command_ok( cmd, args ) {

    try {
        await run( cmd, args, { timeout_ms: 20_000 } )
        return true
    } catch {
        return false
    }

}

/**
 * Wait until a predicate succeeds.
 * @param {string} label - Failure label
 * @param {Function} predicate - Predicate returning truthy on success
 * @param {number} [timeout_ms=30000] - Timeout
 * @returns {Promise<*>}
 */
async function wait_until( label, predicate, timeout_ms = 30_000 ) {

    const deadline = Date.now() + timeout_ms

    while( Date.now() < deadline ) {
        const value = await predicate()
        if( value ) return value
        await new Promise( resolve_wait => setTimeout( resolve_wait, 250 ) )
    }

    throw new Error( `Timed out waiting for ${ label }` )

}

const ensure = ( condition, message ) => {
    if( !condition ) throw new Error( message )
}

const count_occurrences = ( content, needle ) => content.split( needle ).length - 1

const write_file = ( path, content ) => {
    mkdirSync( dirname( path ), { recursive: true } )
    writeFileSync( path, content )
}

const make_workspace = ( name, yaml, files = {} ) => {
    const workspace = join( workspaces_root, name )
    mkdirSync( workspace, { recursive: true } )
    write_file( join( workspace, `babysit.yaml` ), yaml )

    for( const [ relative_path, content ] of Object.entries( files ) ) {
        write_file( join( workspace, relative_path ), content )
    }

    return workspace

}

const latest_session = () => {
    const sessions_dir = join( home, `.babysit/sessions` )
    const files = existsSync( sessions_dir )
        ? readdirSync( sessions_dir ).filter( file => file.endsWith( `.json` ) )
        : []

    ensure( files.length > 0, `No Babysit session metadata was written` )

    const sessions = files.map( file => JSON.parse( readFileSync( join( sessions_dir, file ), `utf8` ) ) )
    return sessions.sort( ( a, b ) => String( b.started_at ).localeCompare( String( a.started_at ) ) )[0]
}

const launch_babysit_command = async ( workspace, args, timeout_ms = 360_000 ) => {

    // In a non-TTY test process, Babysit's foreground tmux attach exits
    // immediately after cmd_start has saved session metadata. The E2E harness
    // intentionally uses that metadata to keep driving the detached tmux pane.
    await run( `node`, [ join( repo_root, `src/index.js` ), ...args ], {
        cwd: workspace,
        env: e2e_env(),
        timeout_ms,
    } )

    const session = latest_session()
    await wait_until( `tmux session ${ session.tmux_session }`, async () => {
        try {
            await tmux( [ `has-session`, `-t`, session.tmux_session ] )
            return true
        } catch {
            return false
        }
    }, 10_000 )

    return session
}

const launch_agent = async ( workspace, agent, args, timeout_ms = 360_000 ) => launch_babysit_command(
    workspace,
    [ agent, ...args ],
    timeout_ms
)

const launch_babysit = async ( workspace, args, timeout_ms = 360_000 ) =>
    launch_agent( workspace, `codex`, args, timeout_ms )

const capture = async ( session ) => {
    const { stdout } = await tmux( [ `capture-pane`, `-t`, session.tmux_session, `-p`, `-S`, `-1000` ] )
    return stdout
}

const send_text = async ( session, text ) => {
    const buffer_name = `babysit-e2e-${ process.pid }-${ Date.now() }-${ Math.random().toString( 36 ).slice( 2 ) }`

    await tmux( [ `set-buffer`, `-b`, buffer_name, text ] )
    await tmux( [ `paste-buffer`, `-pr`, `-d`, `-b`, buffer_name, `-t`, session.tmux_session ] )
    await tmux( [ `send-keys`, `-t`, session.tmux_session, `Enter` ] )
}

const stop_session = async ( session ) => {
    if( !session ) return

    const started_at = Date.now()

    try {
        await send_text( session, `BABYSIT_E2E_EXIT` )
        await wait_until( `session ${ session.tmux_session } to stop`, async () => {
            try {
                await tmux( [ `has-session`, `-t`, session.tmux_session ] )
                return false
            } catch {
                return true
            }
        }, 5_000 )
    } catch ( error ) {
        await tmux( [ `kill-session`, `-t`, session.tmux_session ] ).catch( () => null )
        throw error
    }

    const elapsed_ms = Date.now() - started_at
    console.log( `Natural close: ${ session.agent } ${ elapsed_ms }ms` )
}

const assert_no_orphans = async () => {
    await wait_until( `E2E Docker container cleanup`, async () => {
        const { stdout } = await docker( [
            `ps`, `-aq`,
            `--filter`, `label=babysit.e2e_run=${ run_id }`,
        ] )
        return stdout.trim() === ``
    }, 180_000 )

    const recovery_dir = join( home, `.babysit/credential-recovery` )
    const recovery_markers = existsSync( recovery_dir )
        ? readdirSync( recovery_dir ).filter( file => file.endsWith( `.json` ) )
        : []
    const private_credentials = readdirSync( workspace_tmp )
        .filter( file => file.startsWith( `babysit-creds-` ) )

    ensure( recovery_markers.length === 0, `E2E left credential recovery markers behind` )
    ensure( private_credentials.length === 0, `E2E left private credential sync directories behind` )
}

const build_images = async () => {
    if( process.env.BABYSIT_E2E_SKIP_BUILD === `1` ) return

    if( process.env.BABYSIT_E2E_SKIP_BASE_BUILD !== `1` ) {
        console.log( `Building ${ base_image }` )
        await docker( [
            `build`,
            `-t`, base_image,
            `-f`, join( repo_root, `src/docker/assets/Dockerfile` ),
            join( repo_root, `src/docker/assets` ),
        ], { timeout_ms: 900_000 } )
    } else {
        console.log( `Using existing base image ${ base_image }` )
    }

    console.log( `Building ${ fake_image }` )
    await docker( [
        `build`,
        `-t`, fake_image,
        `--build-arg`, `BASE_IMAGE=${ base_image }`,
        `-f`, join( repo_root, `tests/e2e/assets/Dockerfile.fake` ),
        join( repo_root, `tests/e2e/assets` ),
    ], { timeout_ms: 300_000 } )
}

const run_puppeteer_browser = async () => {
    const browser_script = `
        import { execFileSync } from 'child_process'
        import { statSync } from 'fs'
        import puppeteer from 'puppeteer'

        const pdf_path = '/tmp/babysit-e2e.pdf'
        const preview_path = '/tmp/babysit-e2e-preview'
        const browser = await puppeteer.launch()
        let result

        try {
            const page = await browser.newPage()
            await page.setContent( '<button>Browse</button><output>idle</output><script>document.querySelector("button").addEventListener("click", () => document.querySelector("output").textContent = "clicked")</script>' )
            await page.click( 'button' )
            result = await page.$eval( 'output', element => element.textContent )
            await page.pdf( { path: pdf_path, format: 'A4' } )
        } finally {
            await browser.close()
        }

        const metadata = execFileSync( 'pdfinfo', [ pdf_path ], { encoding: 'utf8' } )
        const text = execFileSync( 'pdftotext', [ pdf_path, '-' ], { encoding: 'utf8' } )
        execFileSync( 'pdftoppm', [ '-f', '1', '-singlefile', '-png', pdf_path, preview_path ] )
        execFileSync( 'qpdf', [ '--check', pdf_path ] )

        if( !metadata.includes( 'Pages:' ) ) throw new Error( 'pdfinfo returned no page count' )
        if( !text.includes( 'Browse' ) ) throw new Error( 'pdftotext returned no page text' )
        if( statSync( \`\${ preview_path }.png\` ).size === 0 ) throw new Error( 'pdftoppm returned an empty preview' )

        console.log( \`PUPPETEER_E2E_\${ result }\` )
        console.log( 'POPPLER_E2E_pdf' )
        console.log( 'QPDF_E2E_pdf' )
    `
    const { stdout } = await docker( [
        `run`, `--rm`, `--init`, `--shm-size=1g`,
        `--security-opt`, `seccomp=${ browser_seccomp_profile }`,
        `--entrypoint`, `gosu`,
        base_image,
        `node`, `node`, `--input-type=module`, `-e`, browser_script,
    ], { timeout_ms: 120_000 } )

    ensure( stdout.includes( `PUPPETEER_E2E_clicked` ), `Puppeteer did not drive bundled Chrome` )
    ensure( stdout.includes( `POPPLER_E2E_pdf` ), `Poppler did not inspect the browser-generated PDF` )
    ensure( stdout.includes( `QPDF_E2E_pdf` ), `qpdf did not validate the browser-generated PDF` )
}

const run_agent_tooling = async () => {
    const tooling_script = `
        set -eu
        test "$(id -u)" -ne 0

        tooling_tmp=$(mktemp -d)
        trap 'rm -rf "$tooling_tmp"' EXIT
        cd "$tooling_tmp"

        mkdir pkgconfig
        printf '%s\\n' \
            'Name: babysit-smoke' \
            'Description: Babysit pkgconf smoke test' \
            'Version: 1.2.3' \
            > pkgconfig/babysit-smoke.pc
        export PKG_CONFIG_PATH="$tooling_tmp/pkgconfig"
        test "$(pkgconf --modversion babysit-smoke)" = '1.2.3'
        test "$(pkg-config --modversion babysit-smoke)" = '1.2.3'

        test -n "$(pstree -p $$)"
        test "$(printf 'SOCAT_OK\\n' | socat - EXEC:/bin/cat)" = 'SOCAT_OK'

        acl_file=/dev/shm/babysit-agent-tooling-acl-$$
        touch "$acl_file"
        setfacl -m u:root:r-- "$acl_file"
        getfacl -cp "$acl_file" | grep -Fx 'user:root:r--'
        rm "$acl_file"

        touch watch.txt
        ( sleep 0.1; printf x >> watch.txt ) &
        inotifywait -q -t 5 -e close_write watch.txt
        printf '%s\\n' "$tooling_tmp/watch.txt" | entr -n -z /bin/true

        unformatted='if true;then echo ok;fi'
        formatted=$(printf '%s\\n' "$unformatted" | shfmt)
        test "$formatted" != "$unformatted"
        test "$formatted" = "$(printf '%s\\n' "$formatted" | shfmt)"

        mkdir filter-repo
        cd filter-repo
        git init -q
        git config user.name 'Babysit E2E'
        git config user.email 'babysit-e2e@example.invalid'
        printf keep > keep.txt
        printf secret > secret.txt
        git add keep.txt secret.txt
        git commit -qm seed
        git filter-repo --force --path secret.txt --invert-paths
        test -f keep.txt
        test ! -e secret.txt
        if git rev-list --objects --all | grep -Fq secret.txt; then exit 1; fi
        cd ..

        printf '%s\\n' 'static int smoke(void) { return 0; }' > source.c
        ctags --options=NONE --output-format=json -f - source.c \
        | jq -e 'select(.name == "smoke")' > /dev/null
        ctags --version | grep -F 'Universal Ctags' > /dev/null

        printf 'AGENT_TOOLING_E2E_ready\\n'
    `
    const { stdout } = await docker( [
        `run`, `--rm`, `--init`,
        base_image,
        `bash`, `-lc`, tooling_script,
    ], { timeout_ms: 120_000 } )

    ensure( stdout.includes( `AGENT_TOOLING_E2E_ready` ), `Bundled agent tooling smoke failed` )
}

const run_puppeteer_headful_browser = async () => {
    const browser_script = `
        import { execFileSync } from 'child_process'
        import puppeteer from 'puppeteer'

        if( process.getuid() === 0 ) throw new Error( 'Headful browser ran as root' )

        const display = execFileSync( 'xdpyinfo', [], { encoding: 'utf8' } )
        if( !/dimensions:\\s+1920x1080 pixels/.test( display ) ) {
            throw new Error( 'xdpyinfo returned the wrong display size' )
        }

        const browser = await puppeteer.launch( { headless: false } )
        try {
            const page = await browser.newPage()
            await page.setContent( '<button>Browse</button><output>idle</output><script>document.querySelector("button").addEventListener("click", () => document.querySelector("output").textContent = "clicked")</script>' )
            await page.click( 'button' )
            const result = await page.$eval( 'output', element => element.textContent )
            console.log( \`XVFB_E2E_\${ result }\` )
        } finally {
            await browser.close()
        }
    `
    const { stdout } = await docker( [
        `run`, `--rm`, `--init`, `--shm-size=1g`,
        `--security-opt`, `seccomp=${ browser_seccomp_profile }`,
        base_image,
        `xvfb-run`, `-a`,
        `--server-args=-screen 0 1920x1080x24 -nolisten tcp`,
        `node`, `--input-type=module`, `-e`, browser_script,
    ], { timeout_ms: 120_000 } )

    ensure( stdout.includes( `XVFB_E2E_clicked` ), `Xvfb did not drive headful bundled Chrome` )
}

const run_submit_parity_sessions = async () => {
    for( const agent of SUPPORTED_AGENTS ) {
        const marker = `BABYSIT_E2E_AUTO_PROMPT_${ agent.toUpperCase() }`
        const initial_prompt = `BABYSIT_E2E_INITIAL_PROMPT_${ agent.toUpperCase() }`
        const workspace = make_workspace( `submit-${ agent }`, `config:
    initial_prompt: "${ initial_prompt }"
babysit:
    - on: "FAKE_AGENT_READY"
      do: "${ marker }"
      timeout: 1
` )
        const session = await launch_agent( workspace, agent, [ `--yolo` ] )

        await wait_until(
            `${ agent } initial prompt marker`,
            () => existsSync( join( workspace, `e2e-initial-prompt.txt` ) )
        )
        await wait_until(
            `${ agent } auto prompt marker`,
            () => existsSync( join( workspace, `e2e-auto-prompt-${ agent }.txt` ) )
        )
        await wait_until(
            `${ agent } all credential marker`,
            () => existsSync( join( workspace, `e2e-all-creds-${ agent }.txt` ) )
        )
        ensure(
            readFileSync( join( workspace, `e2e-all-creds-${ agent }.txt` ), `utf8` ) === `ok`,
            `${ agent } session did not receive every agent credential file`
        )
        ensure(
            readFileSync( join( workspace, `e2e-initial-prompt.txt` ), `utf8` ) === initial_prompt,
            `${ agent } did not receive the exact initial prompt`
        )

        const agent_log = readFileSync( join( workspace, `e2e-fake-agent.log` ), `utf8` )
        ensure(
            count_occurrences( agent_log, `input ${ JSON.stringify( initial_prompt ) }` ) === 1,
            `${ agent } did not submit the initial prompt exactly once`
        )
        ensure(
            !agent_log.includes( `startup input ignored` ),
            `${ agent } sent input before the composer was ready`
        )
        await stop_session( session )
    }
}

const run_default_session = async () => {
    const workspace = make_workspace( `default`, `config:
    initial_prompt: "BABYSIT_E2E_INITIAL_PROMPT"
    idle_timeout_s: 2
    commands:
        marker_command: "printf monitor-command > e2e-monitor-command.txt"
babysit:
    - on: "FAKE_AGENT_READY"
      do: marker_command
      timeout: 1
` )
    const log_path = join( workspace, `e2e.babysit.log` )
    const session = await launch_babysit( workspace, [ `--name`, `feature 1`, `--yolo`, `--docker`, `--log`, log_path ] )

    ensure( session.name === `feature 1`, `session metadata did not preserve --name` )

    await wait_until( `initial prompt marker`, () => existsSync( join( workspace, `e2e-initial-prompt.txt` ) ) )
    await wait_until( `monitor command marker`, () => existsSync( join( workspace, `e2e-monitor-command.txt` ) ) )

    await send_text( session, `BABYSIT_E2E_MANUAL_PROMPT` )
    await wait_until( `manual prompt marker`, () => existsSync( join( workspace, `e2e-manual-prompt.txt` ) ) )

    await send_text( session, `BABYSIT_E2E_DOCKER` )
    await wait_until( `sibling docker marker`, () => existsSync( join( workspace, `e2e-sibling.txt` ) ), 45_000 )

    await wait_until( `tmux log`, () => existsSync( log_path ) && readFileSync( log_path, `utf8` ).includes( `OpenAI Codex` ) )
    ensure( readFileSync( log_path, `utf8` ).includes( `Babysit session start:` ), `tmux log is missing the Babysit header` )

    await send_text( session, `BABYSIT_E2E_ROTATE_CREDS` )
    await send_text( session, `BABYSIT_E2E_EXIT` )
    await wait_until( `credential sync flush`, () => {
        const content = readFileSync( join( home, `.codex/auth.json` ), `utf8` )
        return content.includes( `e2e-rotated-token` )
    }, 120_000 )

}

const run_resume_session = async () => {
    const workspace = make_workspace( `resume`, `config:
    initial_prompt: "BABYSIT_E2E_INITIAL_PROMPT"
babysit: []
` )
    const session = await launch_babysit( workspace, [ `--yolo` ] )

    await wait_until( `initial prompt marker`, () => existsSync( join( workspace, `e2e-initial-prompt.txt` ) ) )
    await wait_until( `captured native session id`, () => {
        const stored = latest_session()
        return stored.babysit_id === session.babysit_id && stored.agent_session_id
    } )

    const native_id = latest_session().agent_session_id
    await stop_session( session )

    const resumed = await launch_babysit_command( workspace, [ `resume`, session.babysit_id ] )
    const resume_args_path = join( workspace, `e2e-resume-args.txt` )
    await wait_until( `resume args marker`, () => existsSync( resume_args_path ) )

    const args = JSON.parse( readFileSync( resume_args_path, `utf8` ) )
    const log_content = readFileSync( join( workspace, `e2e-fake-agent.log` ), `utf8` )
    const initial_prompt_count = count_occurrences( log_content, `BABYSIT_E2E_INITIAL_PROMPT` )

    ensure( args.includes( `resume` ), `resumed Codex command did not include the resume subcommand` )
    ensure( args.includes( native_id ), `resumed Codex command did not use the captured native session id` )
    ensure( initial_prompt_count === 1, `resume should not receive the initial prompt again` )

    await stop_session( resumed )

}

const run_mudbox_session = async () => {
    const workspace = make_workspace( `mudbox`, `config:
    initial_prompt: "BABYSIT_E2E_WRITE_ATTEMPT"
babysit: []
` )
    const session = await launch_babysit( workspace, [ `--mudbox`, `--yolo` ] )

    await wait_until( `mudbox write failure`, async () => ( await capture( session ) ).includes( `WRITE_FAILED /workspace/e2e-write-attempt.txt` ) )
    ensure( !existsSync( join( workspace, `e2e-write-attempt.txt` ) ), `mudbox wrote to the host workspace` )
    await stop_session( session )
}

const run_sandbox_session = async () => {
    const workspace = make_workspace( `sandbox`, `config:
    initial_prompt: "BABYSIT_E2E_SANDBOX_CHECK"
babysit: []
`, {
        'e2e-host-sentinel.txt': `host-only`,
    } )
    const session = await launch_babysit( workspace, [ `--sandbox`, `--yolo` ] )

    await wait_until( `sandbox sentinel absence`, async () => ( await capture( session ) ).includes( `SANDBOX_SENTINEL_ABSENT` ) )
    ensure( !existsSync( join( workspace, `e2e-sandbox-result.txt` ) ), `sandbox wrote a result to the host workspace` )
    await stop_session( session )
}

const run_dependency_session = async () => {
    const workspace = make_workspace( `dependency-isolation`, `config:
    initial_prompt: "BABYSIT_E2E_NODE_MODULES_CHECK"
babysit: []
`, {
        'package.json': `{"name":"babysit-e2e-deps"}`,
        'node_modules/host-sentinel.txt': `host node_modules should be hidden`,
    } )
    const session = await launch_babysit( workspace, [ `--yolo` ] )

    await wait_until( `dependency isolation marker`, () => {
        const marker = join( workspace, `e2e-node-modules.txt` )
        return existsSync( marker ) && readFileSync( marker, `utf8` ).includes( `isolated` )
    } )
    await stop_session( session )
}

const cleanup = async () => {
    await tmux( [ `kill-server` ] ).catch( () => null )

    try {
        const { stdout } = await docker( [ `ps`, `-aq`, `--filter`, `label=babysit.e2e_run=${ run_id }` ] )
        const ids = stdout.split( /\s+/ ).filter( Boolean )
        if( ids.length ) await docker( [ `rm`, `-f`, ...ids ] ).catch( () => null )
    } catch {
        // Cleanup should not mask the real failure.
    }

    if( process.env.BABYSIT_E2E_KEEP_ARTIFACTS !== `1` ) {
        rmSync( root, { recursive: true, force: true } )
        rmSync( state_root, { recursive: true, force: true } )
    } else {
        console.log( `E2E workspace artifacts kept at ${ root }` )
        console.log( `E2E state artifacts kept at ${ state_root }` )
    }
}

try {
    ensure( await command_ok( `tmux`, [ `-V` ] ), `tmux is required for E2E tests` )
    ensure( docker_without_sudo || use_sudo_docker, `Docker is required for E2E tests` )

    await build_images()
    await run_agent_tooling()
    await run_puppeteer_browser()
    await run_puppeteer_headful_browser()

    await run_submit_parity_sessions()
    await run_default_session()
    await run_resume_session()
    await run_mudbox_session()
    await run_sandbox_session()
    await run_dependency_session()
    await assert_no_orphans()

    console.log( `E2E passed` )
} finally {
    await cleanup()
}
