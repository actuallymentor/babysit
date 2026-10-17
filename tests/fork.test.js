import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { parse_args } from '../src/cli/parse.js'
import { get_agent } from '../src/agents/index.js'
import { fork_command_from_menu } from '../src/cli/launcher.js'
import { order_active_sessions, print_active_sessions_table } from '../src/cli/list.js'
import {
    choose_fork_filesystem,
    cmd_fork,
    copy_agent_state_volumes,
    default_fork_filesystem,
    describe_parent_tree,
    fork_prompt_notes,
    format_parent_state,
    merge_fork_flags,
    merge_fork_passthrough,
    plan_fork_history,
    select_fork_parent,
} from '../src/cli/fork.js'

const capture_console = async fn => {
    const original = console.log
    const lines = []
    console.log = ( line = `` ) => lines.push( String( line ) )
    try {
        await fn()
    } finally {
        console.log = original
    }
    return lines.join( `\n` )
}

const git = ( cwd, args ) => spawnSync( `git`, [ `-C`, cwd, `-c`, `user.name=t`, `-c`, `user.email=t@example.invalid`, ...args ], { encoding: `utf8` } ).stdout.trim()

describe( `fork parsing`, () => {

    it( `takes a selector, an optional agent, fork switches and agent passthrough`, () => {

        const cmd = parse_args( [ `fork`, `2`, `codex`, `--clone`, `--takeover`, `--no-yolo`, `--no-history`, `--model`, `gpt`, `--`, `--share` ] )
        expect( cmd ).toMatchObject( { verb: `fork`, agent: `codex`, session_id: `2` } )
        expect( cmd.flags ).toMatchObject( { clone: true, share: false, takeover: true, history: false, unset: [ `yolo` ] } )
        expect( cmd.passthrough ).toEqual( [ `--model`, `gpt`, `--`, `--share` ] )

    } )

    it( `maps agy, keeps booleans from eating the selector, and rejects contradictions`, () => {

        expect( parse_args( [ `fork`, `--share`, `3`, `agy` ] ) ).toMatchObject( { session_id: `3`, agent: `antigravity`, flags: { share: true } } )
        expect( () => parse_args( [ `fork`, `1`, `--share`, `--clone` ] ) ).toThrow( /mutually exclusive/ )
        expect( () => parse_args( [ `fork`, `1`, `--regular`, `--sandbox` ] ) ).toThrow( /--regular/ )
        expect( () => parse_args( [ `fork`, `1`, `nope` ] ) ).toThrow( /Unknown agent/ )
        expect( () => parse_args( [ `fork` ] ) ).toThrow( /Usage: babysit fork/ )

    } )

    it( `leaves --share and --takeover alone for agent launches`, () => {

        expect( parse_args( [ `claude`, `--share`, `x` ] ).passthrough ).toEqual( [ `--share`, `x` ] )

    } )

} )

describe( `fork parent selection`, () => {

    const stored = [
        { babysit_id: `fork-1`, tmux_session: `t-fork`, forked_from: `parent-1`, agent: `codex`, pwd: `/w` },
        { babysit_id: `parent-2`, tmux_session: `t-parent-2`, resumed_from: `parent-1`, agent: `claude`, pwd: `/w`, name: `main` },
        { babysit_id: `parent-1`, tmux_session: `t-parent-1`, superseded_by: `parent-2`, agent: `claude`, pwd: `/w`, agent_session_id: `native-1` },
        { babysit_id: `gone`, tmux_session: `t-gone`, agent: `claude`, pwd: `/w`, forked_from: null },
    ]

    it( `selects list rows, including an exited parent kept for its live fork`, () => {

        const exited_stored = stored.map( session => session.babysit_id === `parent-2` ? { ...session } : session )
        const ordered = order_active_sessions( [ { name: `t-fork` } ], exited_stored )
        expect( ordered.map( row => [ row.name, Boolean( row.exited ) ] ) ).toEqual( [ [ `t-parent-2`, true ], [ `t-fork`, false ] ] )
        expect( select_fork_parent( `1`, ordered, exited_stored ) ).toEqual( { parent: stored[1], number: 1 } )
        expect( select_fork_parent( `2`, ordered, exited_stored ).parent.babysit_id ).toBe( `fork-1` )
        expect( () => select_fork_parent( `3`, ordered, exited_stored ) ).toThrow( /No session numbered 3/ )

    } )

    it( `follows an old id or native id to the conversation's current launch`, () => {

        const ordered = order_active_sessions( [ { name: `t-parent-2` } ], stored )
        expect( select_fork_parent( `parent-1`, ordered, stored ) ).toEqual( { parent: stored[1], number: 1 } )
        expect( select_fork_parent( `native-1`, ordered, stored ).parent.babysit_id ).toBe( `parent-2` )
        expect( select_fork_parent( `gone`, ordered, stored ) ).toEqual( { parent: stored[3], number: null } )
        expect( select_fork_parent( `main`, ordered, stored ).parent.babysit_id ).toBe( `parent-2` )
        expect( () => select_fork_parent( `nothing`, ordered, stored ) ).toThrow( /No session matches/ )

    } )

} )

describe( `fork flag inheritance`, () => {

    const parent = {
        babysit_id: `p`, agent: `claude`, name: `feature`, config_path: `/w/alt.yaml`,
        modifiers: [ `yolo`, `mudbox`, `docker`, `clone`, `loop`, `ignore-host-agents-md` ], ports: [ `3000:3000` ],
        launch_spec: { args: [ `--model`, `opus`, `--effort`, `high` ] },
    }

    it( `inherits switches, mode, config and isolation but never clone or ports`, () => {

        const flags = merge_fork_flags( parent, parse_args( [ `fork`, `1` ] ).flags )
        expect( flags ).toMatchObject( {
            yolo: true, docker: true, loop: true, adb: false, mudbox: true, sandbox: false, clone: false,
            ignore_host_agents_md: true, name: `feature-fork`, config: `/w/alt.yaml`, ports: [],
        } )

    } )

    it( `lets typed flags switch modes and drop inherited switches`, () => {

        expect( merge_fork_flags( parent, parse_args( [ `fork`, `1`, `--sandbox`, `--no-yolo`, `--name`, `other` ] ).flags ) )
            .toMatchObject( { sandbox: true, mudbox: false, yolo: false, docker: true, name: `other` } )
        expect( merge_fork_flags( parent, parse_args( [ `fork`, `1`, `--regular`, `--adb` ] ).flags ) )
            .toMatchObject( { sandbox: false, mudbox: false, adb: true } )
        expect( merge_fork_flags( { ...parent, name: null }, {} ).name ).toBe( false )

    } )

    it( `keeps model/effort only for the same agent and lets typed values replace them`, () => {

        expect( merge_fork_passthrough( parent, `claude`, [] ) ).toEqual( [ `--model`, `opus`, `--effort`, `high` ] )
        expect( merge_fork_passthrough( parent, `claude`, [ `--model=sonnet` ] ) ).toEqual( [ `--effort`, `high`, `--model=sonnet` ] )
        expect( merge_fork_passthrough( parent, `codex`, [ `-c`, `x=1` ] ) ).toEqual( [ `-c`, `x=1` ] )

    } )

} )

describe( `fork filesystem choice`, () => {

    const regular = { sandbox: false, mudbox: false }

    it( `defaults by parent state and fork mode`, () => {

        expect( default_fork_filesystem( { parent_live: true, parent_stuck: false, flags: regular } ) ).toBe( `clone` )
        expect( default_fork_filesystem( { parent_live: true, parent_stuck: true, flags: regular } ) ).toBe( `share` )
        expect( default_fork_filesystem( { parent_live: false, parent_stuck: false, flags: regular } ) ).toBe( `share` )
        expect( default_fork_filesystem( { parent_live: true, parent_stuck: false, flags: { mudbox: true } } ) ).toBe( `share` )
        expect( default_fork_filesystem( { parent_live: true, parent_stuck: false, flags: { sandbox: true } } ) ).toBe( `none` )

    } )

    it( `uses flags, the pre-agreed default, or an answer; never guesses on a pipe`, async () => {

        const tty = { isTTY: true }
        const pipe = { isTTY: false }
        expect( await choose_fork_filesystem( { flags: { share: true }, fallback: `clone`, input: pipe } ) ).toBe( `share` )
        expect( await choose_fork_filesystem( { flags: { clone: true }, fallback: `share`, input: pipe } ) ).toBe( `clone` )
        expect( await choose_fork_filesystem( { flags: {}, fallback: `clone`, assume_default: true, input: pipe } ) ).toBe( `clone` )
        expect( await choose_fork_filesystem( { flags: { mudbox: true }, fallback: `share`, input: pipe } ) ).toBe( `share` )
        expect( await choose_fork_filesystem( { flags: { sandbox: true }, fallback: `none`, input: pipe } ) ).toBe( `none` )
        await expect( choose_fork_filesystem( { flags: {}, fallback: `clone`, input: pipe } ) ).rejects.toThrow( /--share or --clone/ )
        await expect( choose_fork_filesystem( { flags: { mudbox: true, clone: true }, fallback: `share`, input: pipe } ) ).rejects.toThrow( /--mudbox/ )

        const questions = []
        const ask = answer => async question => ( questions.push( question ), answer )
        expect( await choose_fork_filesystem( { flags: {}, fallback: `clone`, ask: ask( `` ), input: tty } ) ).toBe( `clone` )
        expect( questions[0] ).toContain( `[C/s]` )
        expect( await choose_fork_filesystem( { flags: {}, fallback: `clone`, ask: ask( `s` ), input: tty } ) ).toBe( `share` )
        expect( await choose_fork_filesystem( { flags: {}, fallback: `share`, ask: ask( `clone` ), input: tty } ) ).toBe( `clone` )

    } )

} )

describe( `fork history plan`, () => {

    const claude = get_agent( `claude` )
    const parent = { agent: `claude`, agent_session_id: `s-1`, modifiers: [] }

    it( `forks natively for the same agent and hands off otherwise`, () => {

        expect( plan_fork_history( { parent, agent: claude, flags: {} } ).kind ).toBe( `native` )
        expect( plan_fork_history( { parent, agent: get_agent( `codex` ), flags: {} } ).kind ).toBe( `handoff` )
        expect( plan_fork_history( { parent: { ...parent, agent: `antigravity` }, agent: get_agent( `antigravity` ), flags: {} } ).kind ).toBe( `handoff` )
        expect( plan_fork_history( { parent: { ...parent, modifiers: [ `sandbox` ] }, agent: claude, flags: {} } ).kind ).toBe( `handoff` )
        expect( plan_fork_history( { parent, agent: claude, flags: { sandbox: true } } ).kind ).toBe( `handoff` )
        expect( plan_fork_history( { parent: { ...parent, agent_session_id: null }, agent: claude, flags: {} } ).kind ).toBe( `handoff` )
        expect( plan_fork_history( { parent, agent: claude, flags: { history: false } } ).kind ).toBe( `none` )

    } )

    it( `uses each agent's verified native fork flags`, () => {

        expect( claude.flags.fork( `id` ) ).toEqual( [ `--resume`, `id`, `--fork-session` ] )
        expect( get_agent( `codex` ).flags.fork( `id` ) ).toEqual( [ `fork`, `id` ] )
        expect( get_agent( `opencode` ).flags.fork( `id` ) ).toEqual( [ `--session`, `id`, `--fork` ] )
        expect( get_agent( `antigravity` ).flags.fork ).toBe( null )

    } )

    it( `copies workspace-keyed volumes only when the fork moves workspaces`, async () => {

        const calls = []
        const run_command = async ( command, args ) => calls.push( args )
        expect( await copy_agent_state_volumes( get_agent( `codex` ), { from_workspace: `/a`, to_workspace: `/a`, run_command } ) ).toBe( 0 )
        expect( await copy_agent_state_volumes( claude, { from_workspace: `/a`, to_workspace: `/b`, run_command } ) ).toBe( 0 )
        expect( await copy_agent_state_volumes( get_agent( `codex` ), { from_workspace: `/a`, to_workspace: `/b`, run_command } ) ).toBe( 2 )
        expect( calls[0].join( ` ` ) ).toMatch( /babysit-codex-sessions-\w+:\/from:ro -v babysit-codex-sessions-\w+:\/to/ )

    } )

} )

describe( `parent tree state`, () => {

    let directory

    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-fork-tree-` ) )
    } )

    afterEach( () => rmSync( directory, { recursive: true, force: true } ) )

    it( `counts modified, untracked and unpushed work`, () => {

        const remote = join( directory, `remote.git` )
        const tree = join( directory, `tree` )
        spawnSync( `git`, [ `init`, `-q`, `--bare`, remote ] )
        mkdirSync( tree )
        git( tree, [ `init`, `-q`, `-b`, `feat/x` ] )
        writeFileSync( join( tree, `a.txt` ), `a\n` )
        writeFileSync( join( tree, `b.txt` ), `b\n` )
        git( tree, [ `add`, `.` ] )
        git( tree, [ `commit`, `-qm`, `one` ] )
        git( tree, [ `remote`, `add`, `origin`, remote ] )
        git( tree, [ `push`, `-q`, `-u`, `origin`, `feat/x` ] )
        writeFileSync( join( tree, `a.txt` ), `a2\n` )
        git( tree, [ `commit`, `-qam`, `two` ] )
        writeFileSync( join( tree, `a.txt` ), `a3\n` )
        writeFileSync( join( tree, `b.txt` ), `b2\n` )
        writeFileSync( join( tree, `c.txt` ), `c\n` )
        writeFileSync( join( tree, `d.txt` ), `d\n` )
        writeFileSync( join( tree, `e.txt` ), `e\n` )

        const state = describe_parent_tree( tree )
        expect( format_parent_state( state, `live` ) ).toBe( `feat/x · 2 modified · 3 untracked · 1 unpushed · parent: live` )
        expect( state.diff_stat ).toContain( `a.txt` )
        expect( state.unpushed_log ).toContain( `two` )
        expect( format_parent_state( describe_parent_tree( directory ), `exited` ) ).toBe( `no git · parent: exited` )

    } )

    it( `writes prompt notes for each filesystem and history`, () => {

        const clone = fork_prompt_notes( { filesystem: `clone`, history: `handoff`, parent_branch: `feat/x`, clone_branch: `babysit/f-1`, parent_live: true } ).join( `\n` )
        expect( clone ).toContain( `Do not push to the parent's branch feat/x` )
        expect( clone ).toContain( `babysit/f-1` )
        expect( clone ).toContain( `/tmp/babysit-fork-handoff.md` )
        expect( fork_prompt_notes( { filesystem: `share`, history: `native`, parent_live: false } ).join( `\n` ) ).toContain( `has ended` )
        expect( fork_prompt_notes( { filesystem: `share`, history: `native`, parent_live: true } ).join( `\n` ) ).toContain( `share /workspace` )

    } )

} )

describe( `cmd_fork`, () => {

    let directory
    let workspace

    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-fork-cmd-` ) )
        workspace = join( directory, `ws` )
        mkdirSync( workspace )
    } )

    afterEach( () => rmSync( directory, { recursive: true, force: true } ) )

    const run_fork = async ( argv, parent, { live = true, answers = [], run = {} } = {} ) => {
        const started = []
        const closed = []
        const attached = []
        const chdirs = []
        const output = await capture_console( () => cmd_fork( parse_args( argv ), {
            list_sessions_fn: async () => live ? [ { name: parent.tmux_session } ] : [],
            list_stored_sessions_fn: () => [ parent ],
            start: async cmd => {
                started.push( cmd )
                cmd.launch = await cmd.fork.prepare( { workspace: run.workspace || workspace, mode: {}, clone_branch: run.clone_branch || null } )
                return { babysit_id: `fork-id`, name: cmd.flags.name, tmux_session: `t-fork` }
            },
            close: async session => closed.push( session.babysit_id ),
            attach: async name => attached.push( name ),
            ask: answers.length ? async () => answers.shift() : null,
            input: { isTTY: Boolean( answers.length ) },
            chdir: path => chdirs.push( path ),
            read_transcript: async () => ( { transcript: `/home/node/.claude/projects/x/s.jsonl`, user: [ `Build it` ], assistant: [ `Built` ], files: [] } ),
            export_transcript: async ( _, path, dir ) => {
                const local = join( dir, `s.jsonl` )
                writeFileSync( local, `{}` )
                return local
            },
            copy_volumes: run.copy_volumes || ( async () => 0 ),
            forks_dir: join( directory, `forks` ),
            env: {},
        } ) )
        return { started, closed, attached, chdirs, output }
    }

    const parent = () => ( {
        babysit_id: `p-1`, tmux_session: `t-parent`, agent: `claude`, agent_session_id: `native-1`,
        pwd: workspace, original_pwd: workspace, modifiers: [ `yolo` ], name: `feature`, claude_account: `work`,
    } )

    it( `natively forks a live parent into a clone snapshot by default under YOLO`, async () => {

        const { started, chdirs, output } = await run_fork( [ `fork`, `1` ], parent() )
        const [ cmd ] = started

        expect( cmd ).toMatchObject( { verb: `start`, agent: `claude`, detached: true, flags: { clone: true, yolo: true, name: `feature-fork` } } )
        expect( cmd.fork.clone_options ).toEqual( { snapshot: true, tree: null } )
        expect( cmd.fork.record ).toMatchObject( { forked_from: `p-1`, fork_filesystem: `clone`, fork_history: `native` } )
        expect( cmd.fork.claude_account ).toBe( `work` )
        expect( cmd.launch.agent_args ).toEqual( [ `--resume`, `native-1`, `--fork-session` ] )
        // The native conversation already holds the launch prompt
        expect( cmd.launch.prompt( `LAUNCH` ) ).not.toContain( `LAUNCH` )
        expect( cmd.launch.prompt( `LAUNCH` ) ).toContain( `snapshot clone` )
        expect( chdirs ).toEqual( [ workspace ] )
        expect( output ).toContain( `Forked #1 feature` )

    } )

    it( `hands a Claude session to Codex with a handoff file and keeps the launch prompt`, async () => {

        const { started } = await run_fork( [ `fork`, `1`, `codex`, `--share` ], parent() )
        const [ cmd ] = started

        expect( cmd.agent ).toBe( `codex` )
        expect( cmd.fork.claude_account ).toBe( null )
        expect( cmd.fork.record.fork_history ).toBe( `handoff` )
        expect( cmd.launch.agent_args ).toEqual( [] )
        expect( cmd.launch.mounts.map( mount => mount.target ) ).toEqual( [ `/tmp/babysit-fork-handoff.md`, `/tmp/babysit-fork-transcript-s.jsonl` ] )
        const handoff = readFileSync( cmd.fork.record.fork_handoff, `utf8` )
        expect( handoff ).toContain( `> Build it` )
        expect( handoff ).toContain( `/tmp/babysit-fork-transcript-s.jsonl` )
        expect( cmd.launch.prompt( `LAUNCH` ) ).toMatch( /^LAUNCH\n\n[\s\S]*Read \/tmp\/babysit-fork-handoff.md first/ )

    } )

    it( `joins a parent clone when sharing and copies volumes when the workspace moves`, async () => {

        const copies = []
        const clone_parent = { ...parent(), agent: `codex`, clone_id: `c-1`, clone_path: join( directory, `clone` ) }
        mkdirSync( clone_parent.clone_path )
        const shared = await run_fork( [ `fork`, `1`, `--share` ], clone_parent, { run: { workspace: clone_parent.clone_path, copy_volumes: async ( _, paths ) => copies.push( paths ) } } )
        expect( shared.started[0].fork.join_clone_id ).toBe( `c-1` )
        expect( shared.started[0].flags.clone ).toBe( true )
        expect( shared.started[0].launch.agent_args ).toEqual( [ `fork`, `native-1` ] )

        const cloned = await run_fork( [ `fork`, `1`, `--clone` ], clone_parent, { run: { workspace: join( directory, `new` ), copy_volumes: async ( _, paths ) => copies.push( paths ) } } )
        expect( cloned.started[0].fork.clone_options ).toEqual( { snapshot: true, tree: clone_parent.clone_path } )
        expect( copies.at( -1 ) ).toEqual( { from_workspace: clone_parent.clone_path, to_workspace: join( directory, `new` ) } )

        const read_only = await run_fork( [ `fork`, `1`, `--mudbox` ], clone_parent )
        expect( read_only.chdirs ).toEqual( [ clone_parent.clone_path ] )
        expect( read_only.started[0].fork.record.clone_id ).toBe( `c-1` )
        expect( read_only.started[0].flags.clone ).toBe( false )

    } )

    it( `asks about the filesystem and takeover when interactive`, async () => {

        const quiet = { ...parent(), modifiers: [] }
        const { started, closed, attached } = await run_fork( [ `fork`, `1` ], quiet, { answers: [ `s`, `y` ] } )
        expect( started[0].fork.record.fork_filesystem ).toBe( `share` )
        expect( closed ).toEqual( [ `p-1` ] )
        expect( attached ).toEqual( [ `t-fork` ] )

        const kept = await run_fork( [ `fork`, `1`, `--clone` ], quiet, { answers: [ `` ] } )
        expect( kept.closed ).toEqual( [] )

    } )

    it( `closes the parent with --takeover and never asks about an exited one`, async () => {

        expect( ( await run_fork( [ `fork`, `p-1`, `--share`, `--takeover` ], parent() ) ).closed ).toEqual( [ `p-1` ] )
        const exited = await run_fork( [ `fork`, `p-1` ], parent(), { live: false } )
        expect( exited.closed ).toEqual( [] )
        expect( exited.started[0].fork.record.fork_filesystem ).toBe( `share` )
        expect( exited.output ).toContain( `babysit open fork-id` )

    } )

    it( `refuses to guess on a pipe without a filesystem flag`, async () => {

        await expect( run_fork( [ `fork`, `1` ], { ...parent(), modifiers: [] } ) ).rejects.toThrow( /non-interactive/ )

    } )

} )

describe( `fork menu`, () => {

    it( `turns the launch menu's full state into a fork command`, () => {

        const chosen = parse_args( [ `codex`, `--docker`, `--clone`, `--name=n` ] )
        const cmd = fork_command_from_menu( { babysit_id: `p-1` }, chosen )
        expect( cmd ).toMatchObject( { verb: `fork`, agent: `codex`, session_id: `p-1`, flags: { clone: true, share: false, regular: true, docker: true, name: `n` } } )
        expect( cmd.flags.unset ).toEqual( [ `yolo`, `adb`, `loop` ] )
        expect( fork_command_from_menu( { babysit_id: `p` }, parse_args( [ `claude`, `--mudbox` ] ) ).flags ).toMatchObject( { regular: false, share: false, clone: false } )

    } )

} )

describe( `fork tree in babysit list`, () => {

    const stored = [
        { babysit_id: `root`, tmux_session: `t-root`, agent: `claude`, name: `root`, pwd: `/w/app` },
        { babysit_id: `child`, tmux_session: `t-child`, agent: `codex`, name: `child`, pwd: `/w/app`, forked_from: `root` },
        { babysit_id: `grandchild`, tmux_session: `t-grand`, agent: `claude`, name: `grandchild`, pwd: `/w/app`, forked_from: `child` },
        { babysit_id: `sibling`, tmux_session: `t-sibling`, agent: `opencode`, name: `sibling`, pwd: `/w/app`, forked_from: `root` },
        { babysit_id: `other`, tmux_session: `t-other`, agent: `claude`, name: `other`, pwd: `/w/other` },
    ]

    it( `nests forks depth-first under their parent and keeps an exited parent row`, async () => {

        // tmux order puts the forks first and the root has exited
        const live = [ `t-grand`, `t-other`, `t-sibling`, `t-child` ].map( name => ( { name, agent_status: `idle` } ) )
        const ordered = order_active_sessions( live, stored )
        // Siblings keep tmux order among themselves
        expect( ordered.map( row => row.name ) ).toEqual( [ `t-root`, `t-sibling`, `t-child`, `t-grand`, `t-other` ] )

        const output = await capture_console( () => print_active_sessions_table( ordered, stored, { numbered: true } ) )
        const rows = output.split( `\n` ).filter( line => /^\s+[├└]─ \d/.test( line ) )
        expect( rows.map( line => line.trim().split( /\s{2,}/ ).join( ` | ` ) ) ).toEqual( [
            `├─ 1 | root | exited | claude`,
            `├─ 2 | ├─ sibling | idle | opencode`,
            `├─ 3 | └─ child | idle | codex`,
            `└─ 4 | └─ grandchild | idle | claude`,
            `└─ 5 | other | idle | claude`,
        ] )
        // Grandchildren indent under their parent's column
        expect( rows[3] ).toContain( `   └─ grandchild` )
        expect( output ).toContain( `w/app` )
        expect( output ).toContain( `w/other` )

    } )

    it( `hides exited sessions without live descendants and nests under a resumed parent`, () => {

        const resumed = [
            ...stored,
            { babysit_id: `root-2`, tmux_session: `t-root-2`, agent: `claude`, pwd: `/w/app`, resumed_from: `root` },
        ].map( session => session.babysit_id === `root` ? { ...session, superseded_by: `root-2` } : session )
        expect( order_active_sessions( [ { name: `t-other` } ], stored ).map( row => row.name ) ).toEqual( [ `t-other` ] )
        expect( order_active_sessions( [ { name: `t-child` }, { name: `t-root-2` } ], resumed ).map( row => [ row.name, Boolean( row.exited ) ] ) )
            .toEqual( [ [ `t-root-2`, false ], [ `t-child`, false ] ] )

    } )

} )
