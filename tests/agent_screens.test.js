import { describe, expect, test } from 'bun:test'

import { SUPPORTED_AGENTS, get_agent } from '../src/agents/index.js'
import { agent_activity } from '../src/babysit/activity.js'
import { terminal_control } from '../src/control/terminal.js'

const io = screen => ( {
    capture: async () => screen,
    send_text: async () => { throw new Error( `must not type` ) },
    send_keys: async () => { throw new Error( `must not press keys` ) },
} )

describe( `adapter screen knowledge`, () => {

    test( `every agent reads its own activity; only Claude and OpenCode drive a picker`, () => {
        for( const name of SUPPORTED_AGENTS ) expect( typeof get_agent( name ).screen.activity ).toBe( `function` )
        expect( SUPPORTED_AGENTS.filter( name => get_agent( name ).screen.control ) ).toEqual( [ `claude`, `opencode` ] )
        expect( SUPPORTED_AGENTS.filter( name => get_agent( name ).screen.control_while_busy ) ).toEqual( [ `claude` ] )
    } )

    test( `the shared scan runs before an adapter reads its footer`, () => {
        // Interrupt hint is shared; approval lines are each agent's own
        expect( agent_activity( `Working (esc to interrupt)\n? for shortcuts`, `claude` ) ).toBe( `running` )
        expect( agent_activity( `Esc to cancel · Tab to amend`, `claude` ) ).toBe( `idle` )
        // Elsewhere that line is just another interrupt hint
        expect( agent_activity( `Esc to cancel · Tab to amend`, `codex` ) ).toBe( `running` )
        expect( agent_activity( `Press enter to confirm or esc to cancel`, `codex` ) ).toBe( `idle` )
        expect( agent_activity( `Press enter to confirm or esc to cancel`, `opencode` ) ).toBeNull()
        expect( agent_activity( `tab agents  ctrl+p commands`, `opencode` ) ).toBe( `idle` )
    } )

    test( `adapters call their activity with the pane rows and footer`, () => {
        const { activity } = get_agent( `codex` ).screen
        const lines = [ `1 background terminal running · /ps to view · /stop to close`, `› Ask Codex to do anything` ]
        expect( activity( { screen: lines, lines, footer: lines.join( `\n` ) } ) ).toBe( `waiting` )
        expect( activity( { screen: [], lines: [], footer: `` } ) ).toBeNull()
    } )

    test( `composer drafts and owned dialogs are per agent`, () => {
        const claude = get_agent( `claude` ).screen
        expect( claude.composer_draft( `x\n❯ \n────` ) ).toBeNull()
        expect( claude.composer_draft( `x\n❯ Try "fix it"\n────` ) ).toBeNull()
        expect( claude.composer_draft( `x\n❯ half a thought\n────` ) ).toBe( `Claude has a draft in its composer.` )
        expect( claude.composer_draft( `no composer` ) ).toBe( `Claude's composer is not visible.` )
        expect( claude.owned_dialog( `   Select model\n   Switch between Claude models.` ) ).toBe( true )
        expect( claude.owned_dialog( `Select model in prose` ) ).toBe( false )

        const opencode = get_agent( `opencode` ).screen
        expect( opencode.composer_draft( `  ┃\n  ┃  Ask anything…\n  ┃\n  ┃  Build · gpt` ) ).toBeNull()
        expect( opencode.composer_draft( `  ┃\n  ┃  draft\n  ┃\n  ┃  Build · gpt` ) ).toBe( `OpenCode has a draft in its composer.` )
        expect( opencode.owned_dialog( `Select variant esc\n` ) ).toBe( true )
    } )

    test( `Codex has no terminal controller, and waits out a busy turn first`, async () => {
        await expect( terminal_control( { agent: `codex`, operation: `model`, value: `x`, ...io( `›` ) } ) )
            .rejects.toMatchObject( { code: `CONTROL_UNSUPPORTED` } )
        await expect( terminal_control( { agent: `codex`, operation: `model`, value: `x`, busy: true, ...io( `›` ) } ) )
            .rejects.toMatchObject( { code: `CONTROL_PENDING` } )
        await expect( terminal_control( { agent: `opencode`, operation: `model`, value: `x`, busy: true, ...io( `›` ) } ) )
            .rejects.toMatchObject( { code: `CONTROL_PENDING`, message: `Wait for opencode to finish the active turn.` } )
    } )

} )
