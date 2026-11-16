import { last_client_activity } from '../control/stuck.js'
import { log } from '../utils/log.js'
import { DEFAULT_PROMPTS } from './prompts.js'

// Default texts live in prompts.js; re-exported for existing importers
export const WATCHDOG_NUDGE = DEFAULT_PROMPTS.watchdog
export const CHECK_IN_NUDGE = DEFAULT_PROMPTS.check_in

// A check-in answered with a bare "idle" back-off: each one adds another waiting_s
// to the next, up to this many extra (15 → 30 → 45 → 60 min at the default 15)
const MAX_BACKOFF_STEPS = 3

/**
 * Whether the agent's last message is a bare "idle": the last bullet line (an
 * assistant message or a tool call) above the composer says only that.
 * @param {string} screen - Visible pane text, ANSI stripped
 * @returns {boolean}
 */
export const replied_idle = screen => {
    const bullet = String( screen ).split( `\n` ).slice( -25 ).map( line => line.trim() ).filter( line => /^[●•⏺]/.test( line ) ).at( -1 )
    return /^[●•⏺]\s*idle\.?$/i.test( bullet || `` )
}

/**
 * Watch for agents that went quiet without reason. A quiet stretch starts at
 * the last `running` tick; once it outlasts the threshold for the current
 * status, an LLM judges the screen, at most once per stretch, and a stalled
 * verdict queues one nudge. Typing into the session restarts the stretch.
 * An agent waiting on background work skips the judge and is asked to check in
 * every `waiting_s` until it runs again; check-ins the agent answers with a bare
 * "idle" back off by another `waiting_s` each (up to 4x), and any other reply,
 * or typing, starts over.
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
 * @param {Object} [options.prompts] - Nudge texts keyed `watchdog` and `check_in`; defaults to DEFAULT_PROMPTS
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
    prompts = DEFAULT_PROMPTS,
} ) => {

    let stretch = 0
    let quiet_since = null
    let judged = false
    let checking = false
    let nudge = null // Kind of the queued nudge: `watchdog` or `check_in`
    let judged_at = null

    // Consecutive check-ins answered "idle"; a delivered check-in awaits its reply
    let idle_streak = 0
    let awaiting_reply = false
    let reply_started = false

    const limit_s = status => status === `waiting` ? waiting_s * ( 1 + Math.min( idle_streak, MAX_BACKOFF_STEPS ) ) : idle_s
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
            idle_streak = 0
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
            nudge = stalled ? status === `waiting` ? `check_in` : `watchdog` : null
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
        observe( status, screen = `` ) {

            if( status === `running` ) {
                reply_started = awaiting_reply
                return restart()
            }

            // The check-in's turn is over: was the answer a bare "idle"?
            if( awaiting_reply && reply_started ) {
                idle_streak = replied_idle( screen ) ? idle_streak + 1 : 0
                awaiting_reply = reply_started = false
            }

            quiet_since ??= now()

            const limit = limit_s( status )
            if( checking || judged || !limit || excluded( status ) ) return
            if( now() - quiet_since < limit * 1_000 ) return

            check( status )

        },

        /**
         * Input from outside tmux (the web companion) starts a fresh stretch.
         */
        restart: () => {
            idle_streak = 0
            awaiting_reply = reply_started = false
            restart()
        },

        /**
         * Claim a queued nudge, once. Exclusions that arose while the judge
         * thought (stuck, an idle rule taking over) cancel it.
         * @param {'idle'|'running'|'waiting'} status - Current activity
         * @returns {Promise<string|null>} Text the monitor should type, or null
         */
        async take( status ) {

            if( !nudge ) return null
            const kind = nudge
            nudge = null

            // Check-ins repeat every threshold for as long as the agent keeps waiting
            if( kind === `check_in` ) {
                judged = false
                quiet_since = now()
            }

            if( excluded( status ) || kind === `check_in` && status !== `waiting` ) return null

            // Delivery can wait behind other input owners; a draft started since stays untouched
            const typed = await typed_at()
            if( typed && typed > judged_at ) {
                idle_streak = 0
                restart()
                return null
            }

            if( kind === `check_in` ) {
                awaiting_reply = true
                reply_started = false
            }

            return prompts[ kind ]

        },

    }

}
