import { docker_command_prefix } from '../docker/run.js'
import { run } from '../utils/exec.js'
import { log } from '../utils/log.js'

// The in-container deadline kills the judge itself; killing the local
// `docker exec` client alone would leave it running
const JUDGE_TIMEOUT_S = 110
const EXEC_TIMEOUT_MS = 120_000

// Enough scrollback for the last reply and any "subagent finished" lines
// below it, small enough to stay a cheap prompt.
const MAX_SCREEN_CHARS = 24_000

// `docker exec` starts from the container's creation environment, which lacks
// what the entrypoint added (~/.babysitrc, staged credentials, CLAUDE_CONFIG_DIR).
// Borrow the running agent's environment instead: the oldest `node` process.
const AGENT_ENV = `agent=$(pgrep -o -u node)
if [ -n "$agent" ]; then
    while IFS= read -r -d '' variable; do export "$variable"; done < /proc/$agent/environ
fi
exec timeout -k 5 ${ JUDGE_TIMEOUT_S } "$@"`

/*
 * Headless judges, run inside the session's own container: every image ships
 * both CLIs, and the monitor already syncs their credentials back to the host.
 * Claude first, on Haiku; Codex covers accounts without a Claude login.
 */
const JUDGES = [
    {
        name: `claude`,
        // `--tools ""` stays last: it is variadic
        command: prompt => [ `claude`, `-p`, prompt, `--model`, `haiku`, `--no-session-persistence`, `--safe-mode`, `--strict-mcp-config`, `--tools`, `` ],
    },
    {
        name: `codex`,
        command: prompt => [ `codex`, `exec`, `--ephemeral`, `--skip-git-repo-check`, `--sandbox`, `read-only`, `--color`, `never`, `-c`, `mcp_servers={}`, `-c`, `model_reasoning_effort=low`, prompt ],
    },
]

/**
 * Ask whether a quiet agent is parked on purpose or stalled.
 * @param {Object} options
 * @param {string} options.screen - ANSI-free tail of the agent's terminal
 * @param {'idle'|'waiting'} options.status - Activity while quiet
 * @param {number} options.quiet_minutes - Minutes since the agent last worked
 * @returns {string} Judge prompt
 */
export const build_judge_prompt = ( { screen, status, quiet_minutes } ) => `You supervise an autonomous coding agent running in a terminal. It has done no work for ${ quiet_minutes } minutes. ${ status === `waiting`
    ? `Its UI still lists background shells, terminals, or subagents as running.`
    : `Its UI shows nothing running.` }

Decide whether it is parked on purpose or stalled.

Parked on purpose (do not nudge):
- it finished its task and reported the result
- it asked the human a question, or needs a decision, approval, credentials, or other input only the human can give
- it is deliberately waiting on long-running work that is visibly still in progress

Stalled (nudge):
- it said it would wait for subagents, background tasks, or tools that have since finished (e.g. "Completed", "finished", no running indicators left)
- it stopped partway through a plan without asking anything
- it is waiting for something that will never notify it

Reply with only JSON: {"nudge": true or false, "reason": "<one short sentence>"}

<terminal>
${ screen.trimEnd().slice( -MAX_SCREEN_CHARS ) }
</terminal>`

/**
 * Pull the verdict out of a CLI reply, ignoring any banner around it.
 * @param {string} output - Judge stdout
 * @returns {{ nudge: boolean, reason: string }|null} Verdict, or null when unreadable
 */
export const parse_verdict = output => {

    const candidate = String( output ).match( /\{[^{}]*"nudge"[^{}]*\}/g )?.at( -1 )
    if( !candidate ) return null

    try {
        const { nudge, reason } = JSON.parse( candidate )
        if( typeof nudge !== `boolean` ) return null
        return { nudge, reason: String( reason ?? `` ).replace( /\s+/g, ` ` ).trim().slice( 0, 300 ) }
    } catch {
        return null
    }

}

/**
 * Judge a quiet session with the first CLI that answers.
 * @param {Object} options
 * @param {string} options.container_id - Session container
 * @param {string} options.screen - ANSI-free terminal tail
 * @param {'idle'|'waiting'} options.status - Activity while quiet
 * @param {number} options.quiet_minutes - Minutes since the agent last worked
 * @param {Object} [seams]
 * @param {Function} [seams.run_command=run] - Async process runner
 * @returns {Promise<{ nudge: boolean, reason: string, judge: string }|null>} Verdict, or null when no judge answered
 */
export const judge_session = async ( { container_id, screen, status, quiet_minutes }, { run_command = run } = {} ) => {

    const prompt = build_judge_prompt( { screen, status, quiet_minutes } )
    const [ command, ...prefix ] = docker_command_prefix()

    for( const { name, command: judge_command } of JUDGES ) {

        try {

            // /tmp keeps the workspace's agent instructions out of the judge
            const output = await run_command( command, [
                ...prefix, `exec`, `--user`, `node`, `--workdir`, `/tmp`, container_id,
                `bash`, `-c`, AGENT_ENV, `judge`, ...judge_command( prompt ),
            ], {}, EXEC_TIMEOUT_MS )

            const verdict = parse_verdict( output )
            if( verdict ) return { ...verdict, judge: name }
            log.debug( `Watchdog: ${ name } answered without a verdict` )

        } catch ( error ) {
            log.debug( `Watchdog: ${ name } judge failed: ${ error.message }` )
        }

    }

    return null

}
