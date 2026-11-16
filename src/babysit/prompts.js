import { log } from '../utils/log.js'

// Every text babysit types into an agent on its own initiative. Each key backs
// the babysit.yaml `prompts.<key>` override; values are typed followed by Enter.
//
//   loop            --loop with no LOOP.md or ~/.agents/LOOP.md to type at idle
//   watchdog        idle agent that looks stalled mid-task
//   check_in        agent waiting on background work, asked to audit it periodically
//   recovery        first message after a crashed/rebooted session is resumed
//   account_switch  after a Claude limit hit moved the session to another account

// Audit prefix and suffix
const AUDIT_PREFIX = `Evaluate your state and course correct if needed:\n\n`
const AUDIT_SUFFIX = `\nDo work that needs doing without asking for my confirmation, if all is justifiably idle, reply "idle" and nothing else.`

// Make sure that a stalled agent did not exit without cause
const FOCUS_AUDIT = `\n- Have you done all the work requested of you?`
    + `\n- If you finished work since our last check-in, check if you follow all the checklists/workflows specified in AGENTS.md`
    + `\n- Are you working as efficiently and parallelised as you safely could?`

export const DEFAULT_PROMPTS = {

    loop: `Keep going`,

    // Asks for action, not a summary: a stalled agent collects finished work and
    // resumes, one that is fine answers with a single word.
    watchdog: AUDIT_PREFIX
        + `- You look stalled. Check for background agents/shells that already finished: collect their results and clean up. `
        + FOCUS_AUDIT
        + AUDIT_SUFFIX,

    // Waiting agents get no verdict, only a periodic look at their background work:
    // the screen cannot tell a healthy wait from a hung poll, the agent can.
    // Enumerate, don't recall: agents grep for the job they remember and miss the rest.
    check_in: AUDIT_PREFIX
        + `- Audit your background work without filtering by name: list the full process tree under your own process `
        + `(e.g. ps -eo pid,ppid,etime,args), any subagents you started, and the output or log files they write to. `
        + `For each one still alive, say what it's waiting for and whether that can still happen; kill it if not. `
        + `Collect the results of anything that finished and carry on.\n`
        + FOCUS_AUDIT
        + AUDIT_SUFFIX,

    recovery: `You were interrupted. Check the current state, then continue unfinished work.`,

    // Typed after a hot swap, once Escape closed Claude's limit picker
    account_switch: `Your Claude subscription hit its usage limit, so Babysit switched this session to another account. Continue where you left off.`,

}

/**
 * Merge a yaml `prompts:` section over the defaults. A blank or non-string
 * override keeps the default; unknown keys are ignored. Both warn.
 * @param {Object} [raw] - Parsed `prompts:` value from babysit.yaml
 * @returns {Object} A complete prompts object, one string per DEFAULT_PROMPTS key
 */
export const resolve_prompts = raw => {

    const prompts = { ...DEFAULT_PROMPTS }
    if( raw === undefined || raw === null ) return prompts

    if( typeof raw !== `object` || Array.isArray( raw ) ) {
        log.warn( `prompts must be a mapping of prompt names to text; using defaults` )
        return prompts
    }

    for( const [ key, value ] of Object.entries( raw ) ) {

        if( !Object.hasOwn( DEFAULT_PROMPTS, key ) ) {
            log.warn( `prompts.${ key } is not a known prompt (${ Object.keys( DEFAULT_PROMPTS ).join( `, ` ) }); ignoring` )
            continue
        }

        if( typeof value !== `string` || !value.trim() ) {
            log.warn( `prompts.${ key } must be non-empty text; using the default` )
            continue
        }

        prompts[ key ] = value

    }

    return prompts

}
