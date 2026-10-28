import { last_client_activity } from '../control/stuck.js'
import { log } from '../utils/log.js'

// Asks for action, not a summary: a stalled agent collects finished work and
// resumes, one that is fine answers with a single word.
export const WATCHDOG_NUDGE = `You look stalled. Check for background agents/shells that already finished: collect their results and clean up. `
    + `If you stopped for no good reason, resume without asking me. If you're genuinely done or waiting on me, reply "idle" and nothing else.`

// Waiting agents get no verdict, only a periodic look at their background work:
// the screen cannot tell a healthy wait from a hung poll, the agent can.
export const CHECK_IN_NUDGE = `Check in on your background jobs: are they still running and making progress? `
    + `Look at the actual processes and output rather than assuming, since a wait or poll can hang without failing. `
    + `If something is stuck or already finished, deal with it and carry on; if all is well, just say so in a line.`

/**
 * Watch for agents that went quiet without reason. A quiet stretch starts at
 * the last `running` tick; once it outlasts the threshold for the current
 * status, an LLM judges the screen, at most once per stretch, and a stalled
 * verdict queues one nudge. Typing into the session restarts the stretch.
 * An agent waiting on background work skips the judge and is asked to check in
 * every `waiting_s` until it runs again.
 *
 * @param {Object} options
 * @param {string} options.session_name - Tmux session, for the typing check
 * @param {number} options.idle_s - Quiet seconds before judging an idle agent; 0 disables
 * @param {number} options.waiting_s - Quiet seconds between check-ins for a waiting agent; 0 disables
 * @param {Function} options.judge - ({ status, quiet_minutes }) => verdict or null
 * @param {Function} [options.is_stuck] - True while the agent flagged itself stuck
 * @param {Function} [options.skips_idle] - True while an idle rule already nudges
 * @param {Function} [options.typed_at] - Last user keypress in epoch ms, or null
 * @param {Function} [options.now] - Millisecond clock
 * @returns {{ observe: Function, take: Function }}
 */
export const create_watchdog = ( {
    session_name,
    idle_s,
    waiting_s,
    judge,
    is_stuck = () => false,
    skips_idle = () => false,
    typed_at = () => last_client_activity( session_name ),
    now = Date.now,
} ) => {

    let stretch = 0
    let quiet_since = null
    let judged = false
    let checking = false
    let nudge = null
    let judged_at = null

    const limit_s = status => status === `waiting` ? waiting_s : idle_s
    const excluded = status => is_stuck() || status === `idle` && skips_idle()

    const restart = () => {
        stretch++
        quiet_since = null
        judged = false
        nudge = null
    }

    const check = async status => {

        const current = stretch
        const stale = () => current !== stretch
        checking = true

        // The user typing counts as activity: they are handling this session
        const typed_since_quiet = async () => {
            const typed = await typed_at()
            if( stale() || !typed || typed <= quiet_since ) return stale()
            quiet_since = typed
            return true
        }

        try {

            if( await typed_since_quiet() ) return

            const quiet_minutes = Math.round( ( now() - quiet_since ) / 60_000 )
            const verdict = status === `waiting`
                ? { nudge: true, reason: `check-in`, judge: `none` }
                : await judge( { status, quiet_minutes } )
            if( stale() ) return
            if( !verdict ) throw new Error( `no judge answered` )

            // Judging takes a while; a draft typed meanwhile must not get our text appended
            if( await typed_since_quiet() ) return

            const { nudge: stalled, reason, judge: judged_by } = verdict
            judged = true
            judged_at = now()
            nudge = stalled ? status === `waiting` ? CHECK_IN_NUDGE : WATCHDOG_NUDGE : null
            log.info( `Watchdog ${ stalled ? `nudging` : `leaving` } ${ status } ${ session_name } after ${ quiet_minutes }m (${ judged_by }): ${ reason }` )

        } catch ( error ) {

            // Try again after another full threshold, never on the next tick
            log.warn( `Watchdog could not judge ${ session_name }, retrying later: ${ error.message }` )
            if( !stale() ) quiet_since = now()

        } finally {
            checking = false
        }

    }

    return {

        /**
         * Feed each tick's activity; starts a judgment once a stretch is due.
         * @param {'idle'|'running'|'waiting'} status - Current activity
         */
        observe( status ) {

            if( status === `running` ) return restart()

            quiet_since ??= now()

            const limit = limit_s( status )
            if( checking || judged || !limit || excluded( status ) ) return
            if( now() - quiet_since < limit * 1_000 ) return

            check( status )

        },

        /**
         * Input from outside tmux (the web companion) starts a fresh stretch.
         */
        restart,

        /**
         * Claim a queued nudge, once. Exclusions that arose while the judge
         * thought (stuck, an idle rule taking over) cancel it.
         * @param {'idle'|'running'|'waiting'} status - Current activity
         * @returns {Promise<string|null>} Text the monitor should type, or null
         */
        async take( status ) {

            if( !nudge ) return null
            const text = nudge
            nudge = null

            // Check-ins repeat every threshold for as long as the agent keeps waiting
            if( text === CHECK_IN_NUDGE ) {
                judged = false
                quiet_since = now()
            }

            if( excluded( status ) || text === CHECK_IN_NUDGE && status !== `waiting` ) return null

            // Delivery can wait behind other input owners; a draft started since stays untouched
            const typed = await typed_at()
            if( typed && typed > judged_at ) {
                restart()
                return null
            }

            return text

        },

    }

}
