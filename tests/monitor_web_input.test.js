import { describe, expect, test } from 'bun:test'
import { start_monitor } from '../src/babysit/monitor.js'

// One monitor run with a recording web bridge; rules stay gated by input_allowed
const run = async options => {

    let alive = 0
    const published = []
    const processed = []
    const web_bridge = {
        tmux_target: `%7`,
        publish: async snapshot => published.push( snapshot.busy ),
        process_requests: async ( { busy } ) => {
            processed.push( busy )
            return { sent: false, processed: 0 }
        },
        close: async () => null,
    }

    await start_monitor( {
        session_name: `babysit_web`, config: { idle_timeout_s: 300 }, rules: [],
        agent: { name: `claude` }, tmux_target: `%7`,
        open_web_bridge_fn: async () => web_bridge,
        has_session_fn: async () => ++alive <= 1,
        capture_pane_fn: async () => `ready`,
        publish_agent_status_fn: async ( { agent_status } ) => agent_status,
        write_loop_deadline_fn: () => null,
        wait_fn: async () => null,
        ...options,
    } )

    return { published, processed }

}

describe( `web input lock`, () => {

    test( `a stale continuation stops rules, not a person's web message`, async () => {
        const { published, processed } = await run( { input_allowed: () => false, web_input_allowed: () => true } )
        expect( published ).toEqual( [ false ] )
        expect( processed ).toEqual( [ false ] )
    } )

    test( `follows input_allowed unless told otherwise`, async () => {
        const { published, processed } = await run( { input_allowed: () => false } )
        expect( published ).toEqual( [ true ] )
        expect( processed ).toEqual( [ true ] )
    } )

} )
