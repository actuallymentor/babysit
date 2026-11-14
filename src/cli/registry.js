import { SUPPORTED_AGENTS } from '../agents/index.js'
import { DEVICE_KINDS, DEVICE_NAMES } from '../devices/kinds.js'

/*
 * The one registry of Babysit's own flags and commands. The parser's flag
 * lists, help rows, README check, launcher toggles, launch yaml mapping and
 * the session-modifier conversion are all derived from it.
 *
 * Flags
 *   name       long name without dashes (one letter means `-n` style)
 *   alias      one-letter alias (`-h`)
 *   type       boolean | value | optional (a bare `--log` means "default")
 *   scope      global  consumed anywhere, never reaches the agent
 *              launch  babysit <agent> / resume / fork / launch menu; consumed anywhere
 *              command belongs to `commands`; parsed everywhere so it never reads the
 *                      next word as its value, but an agent still receives it
 *              local   belongs to `commands`; parsed only when argv[0] is that command
 *              container  parsed by the in-session helpers, not by parse_args
 *   commands   verbs a command or local flag belongs to
 *   gated      appears in cmd.flags as `verb in commands && args.flag`
 *   implied_by flag that also switches this one on (--devices -> --adb, --ios, --mac)
 *   key        cmd.flags key when it is not the snake_case name
 *   arg        value placeholder in help (`--name NAME`)
 *   usage      help usage when it is not `--name [ARG]`
 *   summary    one-line description: babysit --help, README flag table, agent help
 *   rows       several [ usage, summary ] help rows instead of usage + summary
 *   yaml       `launch:` key in babysit.yaml (toggle for booleans)
 *   yaml_note  comment written above the key by babysit init
 *   modifier   stored session modifier (babysit list flags, resume, recovery)
 *   negatable  `babysit fork --no-X` drops it from the parent
 *   menu       launch menu switch: { group: top|advanced, rank, label }
 *
 * Commands
 *   name       argv[0] (`start`, `launch` and `launch_dir` are parsed verbs, not words)
 *   context    host | container (in-session helpers dispatched before parse_args)
 *   deps       needs the dependency check before it runs
 *   quiet      never starts a background auto-update
 *   hidden     internal, not in help
 *   usage      overview rows [ synopsis, text ]; text may continue on `\n` lines
 *   options    help option rows [ usage, text ]; text null = accepted, undocumented.
 *              Every --flag token in a usage must exist in FLAGS (tested).
 *   subcommands  { name: { options } } for `<command> <sub>` pages and parsing
 */

export const FLAGS = [

    // Launch switches. Order is the yaml order, the launch_flags order, and the help order.
    { name: `yolo`, type: `boolean`, scope: `launch`, yaml: `yolo`, modifier: `yolo`, negatable: true, menu: { group: `top`, rank: 3, label: `YOLO` },
        summary: `Maximum autonomy: skip agent permission prompts, AGENT_AUTONOMY_MODE=yolo` },
    { name: `docker`, type: `boolean`, scope: `launch`, yaml: `docker`, modifier: `docker`, negatable: true, menu: { group: `top`, rank: 1 },
        yaml_note: `Mounts the host Docker socket (sibling containers); agents always run in a container.`,
        summary: `Mount the host Docker socket (controls the host daemon, even in sandbox)` },
    ...DEVICE_KINDS.map( ( { name, label, summary }, index ) => ( {
        name, type: `boolean`, scope: `launch`, yaml: name, modifier: name, negatable: true, implied_by: `devices`, menu: { group: `advanced`, label }, summary,
        ...index === 0 && { yaml_note: `${ DEVICE_KINDS.map( kind => kind.note ).join( `, ` ) }; devices turns on every kind.` },
    } ) ),
    { name: `devices`, type: `boolean`, scope: `launch`, yaml: `devices`, menu: { group: `top`, rank: 2, label: `Devices` },
        summary: `Every device kind: ${ DEVICE_NAMES.map( name => `--${ name }` ).join( `, ` ).replace( /, ([^,]+)$/, ` and $1` ) }` },
    { name: `clone`, type: `boolean`, scope: `launch`, yaml: `clone`, modifier: `clone`, menu: { group: `top`, rank: 4 },
        summary: `Work in a durable copy; the original is mounted read-only at /original` },
    { name: `loop`, type: `boolean`, scope: `launch`, yaml: `loop`, modifier: `loop`, negatable: true, menu: { group: `top`, rank: 5 },
        summary: `When idle, type ./LOOP.md, ~/.agents/LOOP.md, or "Keep going"` },
    { name: `sandbox`, type: `boolean`, scope: `launch`, yaml: `mode`, modifier: `sandbox`,
        summary: `No workspace mount; the container and its files are thrown away` },
    { name: `mudbox`, type: `boolean`, scope: `launch`, yaml: `mode`, modifier: `mudbox`,
        summary: `Read-only workspace mount` },
    { name: `ignore-host-agents-md`, type: `boolean`, scope: `launch`, yaml: `ignore_host_agents_md`, modifier: `ignore-host-agents-md`, menu: { group: `advanced`, label: `Ignore host AGENTS.md` },
        summary: `Leave out host instructions, skills, preferences, and ~/.babysitrc setup; keep credentials` },
    { name: `yes`, type: `boolean`, scope: `launch`,
        summary: `Skip clone safety and --config DIR/ confirmation prompts; with "audit", apply required fixes` },

    // Launch values
    { name: `name`, type: `value`, scope: `launch`, arg: `NAME`,
        summary: `Human-readable session name (shown in babysit list, usable with open)` },
    { name: `config`, type: `value`, scope: `launch`, arg: `FILE`,
        summary: `Use FILE instead of ./babysit.yaml; kept on resume and in clones` },
    { name: `port`, type: `value`, scope: `launch`, key: `ports`, yaml: `ports`, rows: [
        [ `--port PORT`, `Publish host PORT to the same container port; repeatable` ],
        [ `--port H:C`, `Publish host port H to container port C` ],
    ] },
    { name: `log`, type: `optional`, scope: `launch`, yaml: `log`, usage: `--log[=PATH]`,
        summary: `Append raw tmux output to PATH (default .YYYY_MM_DD_HH_MM.babysit.log)` },
    { name: `account`, type: `value`, scope: `launch`, arg: `NAME`,
        summary: `Claude: run on this subscription (babysit auth accounts); default picks most headroom` },

    // `babysit config` settings; consumed anywhere like launch flags
    { name: `transcripts`, type: `value`, scope: `global`, commands: [ `config` ] },
    { name: `auth-check-agents`, type: `value`, scope: `global`, commands: [ `config` ] },

    // Command flags
    { name: `auth`, type: `boolean`, scope: `command`, commands: [ `doctor` ], gated: true,
        summary: `With "babysit doctor", make real model-backed auth checks` },
    { name: `refresh`, type: `boolean`, scope: `command`, commands: [ `doctor` ], gated: true,
        summary: `With "babysit doctor --auth", bypass the 12-hour success cache` },
    { name: `remove`, type: `boolean`, scope: `command`, commands: [ `auth` ], gated: true,
        summary: `With "babysit auth init", uninstall the scheduled checker` },
    { name: `linger`, type: `boolean`, scope: `command`, commands: [ `auth` ], usage: `--no-linger`,
        summary: `With "babysit auth init", do not enable loginctl lingering (checks then stop at logout)` },
    { name: `claude-token`, type: `boolean`, scope: `command`, commands: [ `auth` ],
        summary: `With "babysit auth init", mint a new Claude setup-token even if one is set (--no-claude-token skips)` },
    { name: `token-stdin`, type: `boolean`, scope: `command`, commands: [ `auth` ],
        summary: `With "babysit auth init --claude-token", read the token from a pipe (no TTY or host claude needed)` },
    { name: `all`, type: `boolean`, scope: `command`, commands: [ `list`, `watch`, `resume` ],
        summary: `With "list", show full details; with "resume [number]", use every workspace and show every row` },
    { name: `n`, type: `value`, scope: `command`, commands: [ `resume` ], key: `limit`, arg: `N`,
        summary: `With "resume", show N history rows (default 10)` },
    { name: `user`, type: `value`, scope: `command`, commands: [ `mac`, `windows` ], arg: `USER`,
        summary: `With "mac add" / "windows add", the account to log in as (default: your username)` },
    { name: `password-env`, type: `value`, scope: `command`, commands: [ `mac`, `windows` ], arg: `VAR`,
        summary: `With "mac add" / "windows add", read the account password from environment variable VAR` },
    { name: `password-stdin`, type: `boolean`, scope: `command`, commands: [ `mac`, `windows` ],
        summary: `With "mac add" / "windows add", read the account password from a pipe` },
    { name: `dry-run`, type: `boolean`, scope: `command`, commands: [ `recover`, `clean` ],
        summary: `With "recover", inspect without restarting` },
    { name: `json`, type: `boolean`, scope: `command`, commands: [ `recover` ],
        summary: `With "recover", print machine-readable results` },
    { name: `continue`, type: `boolean`, scope: `command`, commands: [ `recover`, `restart` ], usage: `--no-continue`,
        summary: `With "recover", reopen without submitting a continuation` },
    { name: `list`, type: `boolean`, scope: `command`, commands: [ `prune` ], gated: true,
        summary: `With "prune", list clone workspaces and directory sizes` },
    { name: `boot`, type: `boolean`, scope: `command`, commands: [ `recover` ] },
    { name: `shutdown`, type: `boolean`, scope: `command`, commands: [ `recover` ] },
    { name: `watch`, type: `boolean`, scope: `command`, commands: [ `list` ], gated: true },
    { name: `force`, type: `boolean`, scope: `command`, commands: [ `auth`, `restart` ] },
    { name: `detach`, type: `boolean`, scope: `command`, commands: [ `restart` ] },

    // Parsed only after their own command word
    { name: `share`, type: `boolean`, scope: `local`, commands: [ `fork` ] },
    { name: `takeover`, type: `boolean`, scope: `local`, commands: [ `fork` ] },
    { name: `regular`, type: `boolean`, scope: `local`, commands: [ `fork` ] },
    { name: `history`, type: `boolean`, scope: `local`, commands: [ `fork` ] },
    { name: `usage`, type: `boolean`, scope: `local`, commands: [ `watch` ], gated: true },
    { name: `interactive`, type: `boolean`, scope: `local`, commands: [ `watch` ], gated: true },
    { name: `auto`, type: `boolean`, scope: `local`, commands: [ `update` ], gated: true },

    // In-session helpers parse their own argv
    { name: `status`, type: `value`, scope: `container`, commands: [ `effort`, `model`, `exit`, `stuck`, `reset`, `loop` ] },
    { name: `sort`, type: `value`, scope: `container`, commands: [ `model` ] },
    { name: `limit`, type: `value`, scope: `container`, commands: [ `model` ] },

    { name: `help`, alias: `h`, type: `boolean`, scope: `global`, usage: `-h, --help`, summary: `Show this help` },
    { name: `version`, alias: `v`, type: `boolean`, scope: `global`, usage: `-v, --version`, summary: `Show version` },

]

export const COMMANDS = [

    { name: `launch`, deps: false, usage: [ [ `babysit ["session name"]`, `Open the interactive launch menu` ] ] },
    { name: `start`, deps: true, usage: [
        [ `babysit <agent> [flags]`, `Start a new session` ],
        [ `babysit <agent> resume <id|number>`, `Resume a previous session` ],
    ] },
    { name: `init`, usage: [ [ `babysit init [file.yaml]`, `Write a default config; asks for the file name and launch settings` ] ] },
    { name: `launch_dir`, deps: true, usage: [ [ `babysit --config DIR/ [--yes]`, `Start one detached session per DIR/*.yaml, skipping running ones` ] ] },
    { name: `audit`, usage: [ [ `babysit audit --config FILE|DIR/`, `Fix yaml files so babysit --config DIR/ accepts them; --yes, comments kept` ] ], options: [
        [ `--yes`, `Apply every fix without asking, add nothing.\nA missing agent still needs a terminal.` ],
    ] },
    { name: `clean`, usage: [ [ `babysit clean --config FILE|DIR/`, `Strip full-line comments and blank lines from config yaml; inline comments stay` ] ], options: [
        [ `--dry-run`, `Report what would be removed without writing` ],
    ] },
    { name: `list`, deps: true, usage: [ [ `babysit list [--all]`, `List active sessions and launch flags` ] ], options: [
        [ `--all`, `Add tmux attachment, session IDs, and tmux names` ],
    ] },
    { name: `watch`, deps: true, usage: [
        [ `babysit watch [--usage|--all]`, `Live sessions with usage headroom (--usage: usage only, --all: both)` ],
        [ `babysit watch --interactive`, `Same; navigable in any terminal (arrows + enter or a number opens a session, detaching comes back here), this forces it` ],
    ], options: [
        [ `--usage`, `Only the usage panel` ],
        [ `--all`, `Session tree plus the usage panel` ],
        [ `--interactive`, `Force the navigation keys (always on in a terminal: arrows + enter, or a number; ? lists them)` ],
    ] },
    { name: `open`, deps: true, usage: [ [ `babysit open [id|name|number]`, `Attach to an active session; with shell-init, detaching lands in its workspace` ] ] },
    { name: `shell-init`, quiet: true, usage: [ [ `babysit shell-init [bash|zsh|fish]`, `Shell function so open can cd: eval "$(babysit shell-init)" in your rc` ] ] },
    { name: `resume`, deps: true, usage: [ [ `babysit resume [id|number] [flags]`, `List this workspace's sessions or resume one` ] ], options: [
        [ `--all`, `Every workspace and every row (numbers then refer to this listing)` ],
        [ `-n N`, `Show N rows instead of 10` ],
    ] },
    { name: `fork`, deps: true, usage: [ [ `babysit fork <number|id> [agent]`, `Continue a session in a new one (share or clone the tree, chat kept); --takeover` ] ], options: [
        [ `--share | --clone`, `Pick the filesystem without asking` ],
        [ `--yes`, `Take the defaults (as does --yolo); required on non-interactive stdin without --share/--clone` ],
        [ `--no-history`, `Start a fresh conversation` ],
        [ `--takeover`, `Close the live parent once the fork runs (otherwise: Close #N? [y/N])` ],
        [ `--regular | --sandbox | --mudbox`, `Switch mode` ],
        [ FLAGS.filter( flag => flag.negatable ).map( flag => `--no-${ flag.name }` ).join( `, ` ), `Drop a flag the parent had` ],
        [ `--account NAME`, `Claude subscription; a Claude → Claude fork otherwise keeps the parent's` ],
    ] },
    { name: `prune`, usage: [ [ `babysit prune [--list]`, `Prune unused Docker data and clone workspaces` ] ], options: [
        [ `--list`, `Only show the reclaimable estimates and clone workspaces (no prompts)` ],
    ] },
    { name: `recover`, quiet: true, usage: [
        [ `babysit recover [id|number]`, `Recover interrupted sessions, detached` ],
        [ `babysit recover init`, `Install this account's Ubuntu boot recovery service` ],
    ], options: [
        [ `--dry-run`, `Show candidates and blockers; change nothing` ],
        [ `--json`, `Machine-readable results` ],
        [ `--no-continue`, `Reopen without sending the continuation message` ],
        // Boot service only: the unfiltered sweep at boot, the stamp at shutdown
        [ `--boot`, null ],
        [ `--shutdown`, null ],
    ], subcommands: { init: {} } },
    { name: `close`, usage: [ [ `babysit close <number|id>...`, `Close intentionally; disable recovery for these launches` ] ] },
    { name: `restart`, usage: [ [ `babysit restart <number|id|all>...`, `Rebuild idle session(s) on the current image, keeping the conversation; a terminal can change switches first` ] ], options: [
        [ `--force`, `Restart even when busy or without a captured id` ],
        [ `--detach`, `Return instead of attaching` ],
        [ `--continue`, `Tell the agent to continue unfinished work once it is back` ],
        [ `--account NAME`, `Claude: this subscription instead of the one with most headroom\n(with several sessions or "all": its Claude sessions only)` ],
    ] },
    { name: `archive`, usage: [ [ `babysit archive [<number|id>...]`, `Dim sessions and sink them to the bottom of babysit list; none offers the grey-dot ones; open un-archives` ] ] },
    { name: `freeze`, usage: [ [ `babysit freeze <number|id|all>...`, `Pause session containers in place (docker pause); unfreeze resumes them` ] ] },
    { name: `unfreeze` },
    { name: `config`, usage: [
        [ `babysit config`, `Show settings and setup status` ],
        [ `babysit config --transcripts PATH`, `Archive agent transcripts in PATH (off disables; default ~/.babysit/transcripts)` ],
    ] },
    { name: `mode`, quiet: true, usage: [ [ `babysit mode`, `Print container inside a babysit agent container, else host` ] ] },
    { name: `web`, usage: [
        [ `babysit web init`, `Initialize or rotate babysit-web access` ],
        [ `babysit web key add|list|remove`, `Read-only API keys for the babysit-web JSON API` ],
    ], subcommands: { init: {}, key: {} } },
    { name: `mac`, usage: [
        [ `babysit mac [add [NAME]]`, `Register or update a remote Mac for --mac / --devices sessions (asks for host, user, password)` ],
        [ `babysit mac list|check|enable|disable|forget`, `List, verify (installs the ssh key), choose which Macs sessions get secrets for, or remove Macs` ],
    ], subcommands: { add: {}, list: {}, check: {}, enable: {}, disable: {}, forget: {} } },
    { name: `windows`, usage: [
        [ `babysit windows [add [NAME]]`, `Register or update a Windows PC for --windows / --devices sessions (asks for host, user, password)` ],
        [ `babysit windows list|check|enable|disable|forget`, `List, verify (installs the ssh key), choose which PCs sessions get secrets for, or remove PCs` ],
    ], subcommands: { add: {}, list: {}, check: {}, enable: {}, disable: {}, forget: {} } },
    { name: `doctor`, deps: true, usage: [ [ `babysit doctor --auth [agent|all]`, `Verify real agent authentication` ] ], options: [
        [ `--auth`, `Run the authentication diagnostic (required)` ],
        [ `--refresh`, `Ignore the 12h cache and probe again` ],
    ] },
    { name: `auth`, deps: true, usage: [
        [ `babysit auth [status]`, `Show cached authentication ages and the checker state` ],
        [ `babysit auth check [agent] [--force]`, `Re-verify logins quietly (what the checker runs); --force probes now` ],
        [ `babysit auth init [--remove]`, `Install (or remove) the 10-minute host-level auth checker\nLinux: also enables user lingering; --no-linger opts out\nOffers a one-year Claude token (claude setup-token) when none is set` ],
        [ `babysit auth accounts [remove NAME]`, `Claude subscriptions; add one with auth init --claude-token --name NAME` ],
    ], subcommands: {
        status: {},
        check: { options: [
            [ `agent`, `Check only this agent (${ SUPPORTED_AGENTS.join( `, ` ) })` ],
            [ `--force`, `Probe now regardless of age (session monitors use this)` ],
        ] },
        init: { options: [
            [ `--remove`, `Uninstall the checker (the Claude token stays)` ],
            [ `--no-linger`, `Linux: leave lingering as it is (without it, checks stop when you log out;\nundo an earlier enable with loginctl disable-linger)` ],
            [ `--claude-token`, `Mint a new Claude token even if one is set (e.g. after an alert)` ],
            [ `--no-claude-token`, `Skip the Claude token step` ],
            [ `--name NAME`, `Save the token as an extra Claude account; installs no checker` ],
            [ `--token-stdin`, `Read the token from stdin (with --claude-token); installs no checker` ],
        ] },
        accounts: {},
    } },
    { name: `update`, quiet: true, usage: [
        [ `babysit update`, `Refresh babysit, ~/.agents, docker image, running web (verbose)` ],
        [ `babysit update --auto`, `Ask to turn background updates on new releases on or off` ],
    ] },
    { name: `__monitor`, quiet: true, hidden: true },

    // In-session helpers: dispatched before parse_args, text lives in the container assets
    { name: `effort`, context: `container`, usage: [ [ `babysit effort [level]`, `Inspect/change effort inside a managed agent session` ] ] },
    { name: `model`, context: `container`, usage: [
        [ `babysit model [model-name]`, `List/change models in the current agent session` ],
        [ `babysit model --benchmarks`, `Compare benchmarks; --sort intelligence is default` ],
    ] },
    { name: `exit`, context: `container`, usage: [ [ `babysit exit [--yes]`, `End the session gracefully after the current turn (asks first)` ] ] },
    { name: `stuck`, context: `container`, usage: [ [ `babysit stuck`, `Show "stuck" in babysit list until the user types` ] ] },
    { name: `loop`, context: `container`, usage: [ [ `babysit loop`, `Toggle --loop (list flags and tmux bar follow)` ] ] },
    { name: `reset`, context: `container`, usage: [ [ `babysit reset`, `Clear context and resend the initial prompt` ] ] },
    { name: `usage`, context: `container`, usage: [ [ `babysit usage [--json]`, `Account usage and limits, on host or in container` ] ] },

]

/* ---------------------------------------------------------------------------
 * Lookups
 * ------------------------------------------------------------------------- */

const by_name = Object.fromEntries( FLAGS.map( flag => [ flag.name, flag ] ) )

/** @returns {Object|undefined} Registry entry for a flag name without dashes */
export const flag_named = name => by_name[ name ]

/** @returns {Object|undefined} Registry entry for a command word */
export const command_named = name => COMMANDS.find( command => command.name === name )

/** cmd.flags key of a flag: `ignore-host-agents-md` -> `ignore_host_agents_md` */
export const flag_key = flag => flag.key || flag.name.replaceAll( `-`, `_` )

/** Command-line spelling: `--name`, or `-n` for one-letter flags */
export const dashed = name => name.length === 1 ? `-${ name }` : `--${ name }`

const of = ( ...scopes ) => FLAGS.filter( flag => scopes.includes( flag.scope ) )

/* ---------------------------------------------------------------------------
 * Parser lists
 * ------------------------------------------------------------------------- */

// Consumed wherever they appear; everything else may pass through to the agent CLI
export const KNOWN_FLAGS = of( `global`, `launch` ).map( flag => flag.name )

// Booleans mri knows for every verb
export const BOOLEAN_FLAGS = of( `global`, `launch`, `command` ).filter( flag => flag.type === `boolean` ).map( flag => flag.name )

// Value-taking flags: mri's `string` list and the passthrough value skipper
export const VALUE_FLAGS = of( `global`, `launch`, `command` ).filter( flag => flag.type !== `boolean` ).map( flag => flag.name )

// Flags whose bare form means "default value" (`--log` -> `--log=`)
export const OPTIONAL_FLAGS = FLAGS.filter( flag => flag.type === `optional` ).map( flag => flag.name )

/** Booleans parsed only when argv[0] is `verb` (`babysit fork --share`) */
export const local_flags = verb => of( `local` ).filter( flag => flag.commands.includes( verb ) ).map( flag => flag.name )

// `babysit fork --no-X` drops these inherited switches
export const FORK_NEGATABLE_FLAGS = FLAGS.filter( flag => flag.negatable ).map( flag => flag.name )

/** Accepted argv tokens of a command's (or subcommand's) options */
export const option_tokens = ( name, sub = null ) => {
    const command = command_named( name )
    const options = ( sub ? command?.subcommands?.[ sub ]?.options : command?.options ) || []
    return options.flatMap( ( [ usage ] ) => usage.match( /(?<![\w-])--?[a-z][\w-]*/g ) || [] )
}

/* ---------------------------------------------------------------------------
 * Help
 * ------------------------------------------------------------------------- */

/** Help rows of a flag: [ [ usage, summary ], ... ] */
export const flag_rows = flag => {
    if( flag.rows ) return flag.rows
    if( !flag.summary ) return []
    const usage = flag.usage || `${ dashed( flag.name ) }${ flag.arg ? ` ${ flag.arg }` : `` }`
    return [ [ usage, flag.summary ] ]
}

// Flags with help rows, in registry order; launch first, help and version last
export const LAUNCH_FLAG_ROWS = of( `launch` ).flatMap( flag_rows )
export const OVERVIEW_FLAG_ROWS = FLAGS.flatMap( flag_rows )

/**
 * Render [ usage, text ] rows as an indented two-column table. Text lines after
 * the first are aligned under the text column; usages wider than the column get
 * their text on the next line when `wrap` is set, else after two spaces.
 * @param {Array<[string, string|null]>} rows - Usage/text pairs; null text rows are skipped
 * @param {Object} [options]
 * @param {number} [options.width] - Usage column width (default: widest usage up to 24, plus 3)
 * @param {boolean} [options.wrap=false] - Put text under an over-wide usage
 * @returns {string}
 */
export const format_rows = ( rows, { width, wrap = false } = {} ) => {

    const shown = rows.filter( ( [ , text ] ) => text !== null )
    const column = width ?? Math.min( 24, Math.max( ...shown.map( ( [ usage ] ) => usage.length ) ) ) + 3
    const indent = ` `.repeat( column + 2 )

    return shown.map( ( [ usage, text ] ) => {
        const [ first, ...rest ] = text.split( `\n` )
        const head = wrap && usage.length > column - 2 ? `  ${ usage }\n${ indent }${ first }` : `  ${ usage.padEnd( column - 2 ) }  ${ first }`
        return [ head, ...rest.map( line => `${ indent }${ line }` ) ].join( `\n` )
    } ).join( `\n` )

}

/** `Options:` block of a command or subcommand page */
export const options_table = ( name, sub = null ) => {
    const command = command_named( name )
    const options = sub ? command.subcommands[ sub ].options : command.options
    return `Options:\n${ format_rows( options ) }`
}

/* ---------------------------------------------------------------------------
 * Launch: yaml, menu, stored modifiers
 * ------------------------------------------------------------------------- */

// Boolean `launch:` keys, in yaml order
export const LAUNCH_TOGGLES = FLAGS.filter( flag => flag.type === `boolean` && flag.yaml && flag.yaml !== `mode` ).map( flag => flag.yaml )

/**
 * The Babysit flags a launch section stands for, minus agent and name.
 * @param {Object} launch - Validated launch section
 * @returns {string[]} e.g. `[ '--yolo', '--docker', '--port=3000' ]`
 */
export const launch_flags = launch => FLAGS.filter( flag => flag.yaml ).flatMap( flag => {
    const value = launch[ flag.yaml ]
    if( flag.yaml === `mode` ) return value === flag.name ? [ `--${ flag.name }` ] : []
    if( flag.type === `boolean` ) return value ? [ `--${ flag.name }` ] : []
    if( flag.type === `optional` ) return value === false ? [] : [ value === true ? `--${ flag.name }` : `--${ flag.name }=${ value }` ]
    return value.map( item => `--${ flag.name }=${ item }` )
} )

const menu_group = group => FLAGS.filter( flag => flag.menu?.group === group )
    .sort( ( a, b ) => ( a.menu.rank ?? 0 ) - ( b.menu.rank ?? 0 ) )
    .map( flag_key )

// Launch menu switches: top-level ones persist per workspace, Advanced ones never do
export const MENU_TOGGLES = menu_group( `top` )
export const MENU_ADVANCED_TOGGLES = menu_group( `advanced` )
export const MENU_LABELS = Object.fromEntries( FLAGS.filter( flag => flag.menu?.label ).map( flag => [ flag_key( flag ), flag.menu.label ] ) )

const MODIFIER_FLAGS = FLAGS.filter( flag => flag.modifier )

/**
 * Stored session modifiers for a set of flags, in the input's key order.
 * @param {Object} flags - e.g. the launch mode plus `loop`
 * @returns {string[]} e.g. `[ 'yolo', 'ignore-host-agents-md', 'loop' ]`
 */
export const modifiers_from_flags = flags => Object.entries( flags )
    .map( ( [ key, value ] ) => value && MODIFIER_FLAGS.find( flag => flag_key( flag ) === key )?.modifier )
    .filter( Boolean )

/**
 * Flags a session's stored modifiers stand for; every modifier flag is present.
 * @param {string[]} [modifiers]
 * @returns {Object} e.g. `{ yolo: true, sandbox: false, ..., ignore_host_agents_md: false }`
 */
export const flags_from_modifiers = ( modifiers = [] ) => Object.fromEntries(
    MODIFIER_FLAGS.map( flag => [ flag_key( flag ), modifiers.includes( flag.modifier ) ] )
)
