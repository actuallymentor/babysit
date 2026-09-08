import { describe, it, expect } from 'bun:test'
import { agent_activity, agent_status } from '../src/babysit/activity.js'

describe( `agent activity controls`, () => {

    it( `keeps an idle Claude composer idle while its loop countdown changes`, () => {
        for( const countdown of [ `00:04:59`, `00:04:58` ] ) {
            const output = `Finished the requested changes.\n❯ \n  ? for shortcuts\nloop ${ countdown } · workspace`
            expect( agent_status( output, `claude`, 0 ) ).toBe( `idle` )
        }
    } )

    it( `keeps a static busy control running beyond the idle threshold`, () => {
        const screens = {
            codex: `• Working (30s • esc to interrupt)\n\n› Ask a follow-up question`,
            claude: `✻ Thinking…\n  esc to interrupt\n❯ `,
        }

        for( const [ agent, screen ] of Object.entries( screens ) ) {
            expect( agent_status( screen, agent, 30 ) ).toBe( `running` )
        }
    } )

    it( `recognizes approval controls as waiting for input despite cancellation hints`, () => {
        const dialogs = [
            [ `codex`, `Would you like to run the following command?\n› 1. Yes, proceed\n  2. No\n  Press enter to confirm or esc to cancel` ],
            [ `codex`, `Implement this plan?\n› 1. Yes, implement this plan\n  2. No, stay in Plan mode\n  Press enter to confirm or esc to go back` ],
            [ `claude`, `Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel · Tab to amend · ctrl+e to explain` ],
        ]

        for( const [ agent, dialog ] of dialogs ) {
            expect( agent_status( dialog, agent, 0 ) ).toBe( `idle` )
            expect( agent_status( dialog, agent, 30 ) ).toBe( `idle` )
        }
    } )

    it( `does not mistake prose about approval controls for a live dialog`, () => {
        const output = `The dialog says Press enter to confirm or esc to cancel\n• Working (30s • esc to interrupt)`
        expect( agent_activity( output, `codex` ) ).toBe( `running` )
    } )

    it( `uses the latest explicit control when an old dialog or busy line remains`, () => {
        const approval = `Esc to cancel · Tab to amend`
        const busy = `✻ Working… (30s · esc to interrupt)`

        expect( agent_activity( `${ approval }\n${ busy }\n? for shortcuts`, `claude` ) ).toBe( `running` )
        expect( agent_activity( `${ busy }\n${ approval }`, `claude` ) ).toBe( `idle` )
    } )

    it( `gives interrupt controls priority over a visible composer`, () => {
        expect( agent_activity( `Working… (esc to interrupt)\n› Ask a follow-up question\n? for shortcuts`, `codex` ) ).toBe( `running` )
    } )

    it( `recognizes supported idle controls with ANSI and trailing blank pane rows`, () => {
        const screens = {
            codex: `› Ask Codex to do anything`,
            claude: `  ? for shortcuts`,
            gemini: `│ > Type your message or @path/to/file │`,
            opencode: `tab agents  ctrl+p commands`,
        }

        for( const [ agent, screen ] of Object.entries( screens ) ) {
            expect( agent_activity( `\x1b[32m${ screen }\x1b[0m${ `\n`.repeat( 20 ) }`, agent ) ).toBe( `idle` )
        }
    } )

    it( `ignores controls in older transcript rows`, () => {
        const output = `Old tool: esc to interrupt\n${ `Transcript line\n`.repeat( 10 ) }› Ask a follow-up question`
        expect( agent_activity( output, `codex` ) ).toBe( `idle` )
    } )

    it( `does not treat prose mentioning shortcut text as an idle control`, () => {
        expect( agent_activity( `The documentation says ? for shortcuts`, `claude` ) ).toBeNull()
        expect( agent_activity( `The documentation says esc to interrupt\n› Ask a follow-up question`, `codex` ) ).toBe( `idle` )
    } )

    it( `falls back to stability for unknown screens and agents`, () => {
        expect( agent_activity( `Authentication required`, `codex` ) ).toBeNull()
        expect( agent_activity( `? for shortcuts`, `unknown` ) ).toBeNull()
        expect( agent_status( `Authentication required`, `codex`, 0 ) ).toBe( `running` )
        expect( agent_status( `Authentication required`, `codex`, 2 ) ).toBe( `idle` )
    } )

} )
