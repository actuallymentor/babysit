import { last_client_activity } from '../control/stuck.js'
import { log } from '../utils/log.js'

// Short on purpose: an agent that is fine answers with a summary, a stalled
// one usually picks its work back up.
export const WATCHDOG_NUDGE = `Status report`

/**
 * Watch for agents that went quiet without reason. A quiet stretch starts at
 * the last `running` tick; once it outlasts the threshold for the current
 * status, an LLM judges the screen, at most once per stretch, and a stalled
 * verdict queues one nudge. Typing into the session restarts the stretch.
 *
 * @param {Object} options
 * @param {string} options.session_name - Tmux session, for the typing check
 * @param {number} options.idle_s - Quiet seconds before judging an idle agent; 0 disables
 * @param {number} options.waiting_s - Quiet seconds before judging a waiting agent; 0 disables
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
    let nudge = false
    let judged_at = null

    const limit_s = status => status === `waiting` ? waiting_s : idle_s
    const excluded = status => is_stuck() || status === `idle` && skips_idle()

    const restart = () => {
        stretch++
        quiet_since = null
        judged = false
        nudge = false
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
            const verdict = await judge( { status, quiet_minutes } )
            if( stale() ) return
            if( !verdict ) throw new Error( `no judge answered` )

            // Judging takes a while; a draft typed meanwhile must not get our text appended
            if( await typed_since_quiet() ) return

            const { nudge: stalled, reason, judge: judged_by } = verdict
            judged = true
            judged_at = now()
            nudge = stalled
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
         * @returns {Promise<boolean>} True when the monitor should send WATCHDOG_NUDGE
         */
        async take( status ) {

            if( !nudge ) return false
            nudge = false
            if( excluded( status ) ) return false

            // Delivery can wait behind other input owners; a draft started since stays untouched
            const typed = await typed_at()
            if( typed && typed > judged_at ) {
                restart()
                return false
            }

            return true

        },

    }

}
