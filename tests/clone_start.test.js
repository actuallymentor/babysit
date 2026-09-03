import { describe, expect, it } from 'bun:test'

import {
    active_sessions_for_original,
    allows_default_yes,
    confirm_default_yes,
    ensure_clone_safety_prompt,
    recover_clone_container,
} from '../src/cli/start.js'
import { clone as clone_prompt } from '../src/system_prompt/index.js'

describe( `clone launch safety`, () => {

    it( `uses a default-yes confirmation answer`, () => {
        expect( allows_default_yes( `` ) ).toBe( true )
        expect( allows_default_yes( `Y` ) ).toBe( true )
        expect( allows_default_yes( `yes` ) ).toBe( true )
        expect( allows_default_yes( `n` ) ).toBe( false )
        expect( allows_default_yes( `anything else` ) ).toBe( false )
    } )

    it( `fails closed without an interactive terminal`, async () => {
        expect( await confirm_default_yes( `Continue? [Y/n] `, {
            input: { isTTY: false },
        } ) ).toBe( false )
    } )

    it( `classifies only live sessions for the canonical original`, () => {

        const tmux_sessions = [
            { name: `clone-live` },
            { name: `direct-live` },
        ]
        const stored_sessions = [
            {
                tmux_session: `clone-live`,
                original_pwd: `/workspace/project`,
                clone_path: `/tmp/clone`,
                modifiers: [ `clone` ],
            },
            {
                tmux_session: `direct-live`,
                pwd: `/workspace/project`,
                modifiers: [],
            },
            {
                tmux_session: `clone-stale`,
                pwd: `/workspace/project`,
                clone_path: `/tmp/stale`,
                modifiers: [ `clone` ],
            },
            {
                tmux_session: `other-live`,
                pwd: `/workspace/other`,
                modifiers: [],
            },
        ]

        const active = active_sessions_for_original(
            `/workspace/project`,
            tmux_sessions,
            stored_sessions
        )

        expect( active.clones.map( session => session.tmux_session ) ).toEqual( [ `clone-live` ] )
        expect( active.direct.map( session => session.tmux_session ) ).toEqual( [ `direct-live` ] )

    } )

    it( `adds mandatory clone guidance to custom and empty prompts once`, () => {
        expect( ensure_clone_safety_prompt( `Custom task`, { clone: true } ) ).toBe( `Custom task\n\n${ clone_prompt }` )
        expect( ensure_clone_safety_prompt( ``, { clone: true } ) ).toBe( clone_prompt )
        expect( ensure_clone_safety_prompt( clone_prompt, { clone: true } ) ).toBe( clone_prompt )
        expect( ensure_clone_safety_prompt( `Custom task`, {} ) ).toBe( `Custom task` )
    } )

} )

describe( `clone container recovery`, () => {

    it( `stops and finalizes a surviving running container`, async () => {

        const calls = []
        const session = {
            babysit_id: `session-id`,
            container_name: `babysit-session-id`,
            monitor_pid: null,
        }

        expect( await recover_clone_container( session, {
            inspect_container: async container => {
                calls.push( [ `inspect`, container ] )
                return `running`
            },
            stop_container: async container => calls.push( [ `stop`, container ] ),
            update_session_fn: ( id, updates ) => calls.push( [ `update`, id, updates ] ),
            recover_session: async command => calls.push( [ `recover`, command ] ),
        } ) ).toBe( true )

        expect( calls ).toEqual( [
            [ `inspect`, `babysit-session-id` ],
            [ `stop`, `babysit-session-id` ],
            [ `update`, `session-id`, { container_id: `babysit-session-id` } ],
            [ `recover`, { session_id: `session-id`, monitor_token: null } ],
        ] )

    } )

    it( `does nothing when Docker has no surviving container`, async () => {
        expect( await recover_clone_container( {
            container_name: `missing`,
        }, {
            inspect_container: async () => null,
        } ) ).toBe( false )
    } )

    it( `removes a stale container directly after credentials were finalized`, async () => {

        const calls = []
        const recovered = await recover_clone_container( {
            babysit_id: `clone-clean`,
            container_id: `container-clean`,
            credentials_cleaned: true,
        }, {
            inspect_container: async () => `exited`,
            monitor_alive: () => false,
            remove_container: async container => calls.push( [ `remove`, container ] ),
            recover_session: async () => calls.push( [ `recover` ] ),
            stop_container: async () => calls.push( [ `stop` ] ),
            update_session_fn: ( id, updates ) => calls.push( [ `update`, id, updates ] ),
        } )

        expect( recovered ).toBe( true )
        expect( calls ).toEqual( [
            [ `remove`, `container-clean` ],
            [ `update`, `clone-clean`, { container_cleaned: true } ],
        ] )

    } )

    it( `does not race a live cleanup monitor`, async () => {
        await expect( recover_clone_container( {
            babysit_id: `session-id`,
            container_name: `babysit-session-id`,
            monitor_pid: 123,
        }, {
            inspect_container: async () => `exited`,
            monitor_alive: () => true,
        } ) ).rejects.toThrow( `cleanup is still running` )
    } )

} )
