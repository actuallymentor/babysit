import { describe, it, expect } from 'bun:test'
import {
    allows_docker_restricted_mode,
    should_confirm_docker_restricted_mode,
} from '../src/cli/start.js'

describe( `--docker restricted-mode guard`, () => {

    const without_yolo_env = ( fn ) => {

        const previous = process.env.AGENT_AUTONOMY_MODE
        delete process.env.AGENT_AUTONOMY_MODE

        try {
            return fn()
        } finally {
            if( previous === undefined ) delete process.env.AGENT_AUTONOMY_MODE
            else process.env.AGENT_AUTONOMY_MODE = previous
        }

    }

    it( `asks for confirmation when docker is combined with sandbox`, () => {
        without_yolo_env( () => expect( should_confirm_docker_restricted_mode( {
            docker: true,
            sandbox: true,
            mudbox: false,
            yolo: false,
        } ) ).toBe( true ) )
    } )

    it( `asks for confirmation when docker is combined with mudbox`, () => {
        without_yolo_env( () => expect( should_confirm_docker_restricted_mode( {
            docker: true,
            sandbox: false,
            mudbox: true,
            yolo: false,
        } ) ).toBe( true ) )
    } )

    it( `skips confirmation in yolo mode`, () => {
        expect( should_confirm_docker_restricted_mode( {
            docker: true,
            sandbox: true,
            mudbox: false,
            yolo: true,
        } ) ).toBe( false )
    } )

    it( `requires an explicit yes answer`, () => {
        expect( allows_docker_restricted_mode( `Y` ) ).toBe( true )
        expect( allows_docker_restricted_mode( `yes` ) ).toBe( true )
        expect( allows_docker_restricted_mode( `` ) ).toBe( false )
        expect( allows_docker_restricted_mode( `n` ) ).toBe( false )
    } )

} )
