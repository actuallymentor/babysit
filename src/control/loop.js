import { apply_loop } from '../modes/loop.js'
import { format_session_status_label } from '../cli/list.js'
import { set_status_label } from '../tmux/session.js'
import { log } from '../utils/log.js'

/**
 * `babysit loop`: toggle --loop on a running session. The session record's
 * modifiers drive `babysit list` flags and resume; the tmux bar label is
 * rewritten; the monitor's live rule list is rebuilt from the config with or
 * without the loop override.
 * @param {Object} session - Session record (mutated: modifiers)
 * @param {Object} options
 * @param {Object[]} options.rules - The monitor's live rules, replaced in place
 * @param {string} options.workspace - Where LOOP.md is looked up
 * @param {Function} options.load_rules - Fresh rules from the config
 * @param {Function} options.update - Session record writer
 * @param {Function} [options.set_label] - Tmux label writer seam
 * @param {Function} [options.apply] - apply_loop seam
 * @returns {{ toggle: Function, enabled: boolean }}
 */
export const create_loop_controller = ( session, {
    rules,
    workspace,
    load_rules,
    update,
    set_label = set_status_label,
    apply = apply_loop,
} ) => {

    const modifiers = () => session.modifiers || []
    const enabled = () => modifiers().includes( `loop` )

    const rebuild_rules = () => {
        rules.splice( 0, rules.length, ...load_rules() )
        if( enabled() ) apply( rules, workspace, {
            include_global_loop: !modifiers().includes( `ignore-host-agents-md` ),
            config_path: session.config_path || null,
        } )
    }

    return {

        get enabled() {
            return enabled()
        },

        toggle: async () => {
            session.modifiers = enabled()
                ? modifiers().filter( modifier => modifier !== `loop` )
                : [ ...modifiers(), `loop` ]
            update( session.babysit_id, { modifiers: session.modifiers } )
            rebuild_rules()
            try {
                await set_label( session.tmux_session, format_session_status_label( {
                    name: session.name, pwd: session.original_pwd || session.pwd, modifiers: session.modifiers,
                } ) )
            } catch ( error ) {
                log.debug( `Could not refresh the tmux label: ${ error.message }` )
            }
            return `Looping is now ${ enabled() ? `enabled` : `disabled` }.`
        },

    }

}
