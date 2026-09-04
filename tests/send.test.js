import { describe, it, expect } from 'bun:test'
import { send_text } from '../src/tmux/send.js'

const collect_calls = () => {

    const calls = []
    const waits = []
    const runner = async ( cmd, args ) => {
        calls.push( { cmd, args } )
        return ``
    }
    const wait_fn = async milliseconds => waits.push( milliseconds )

    return { calls, runner, wait_fn, waits }

}

describe( `send_text`, () => {

    it( `pastes single-line text and submits it`, async () => {

        const { calls, runner, wait_fn, waits } = collect_calls()

        await send_text( `session`, `Use $HOME wisely`, { runner, wait_fn } )

        expect( calls.map( c => c.cmd ) ).toEqual( [ `tmux`, `tmux`, `tmux` ] )
        expect( calls[0].args ).toContain( `set-buffer` )
        expect( calls[0].args.at( -2 ) ).toBe( `--` )
        expect( calls[0].args.at( -1 ) ).toBe( `Use $HOME wisely` )
        expect( calls[1].args ).toContain( `paste-buffer` )
        expect( calls[1].args ).toContain( `-pr` )
        expect( calls[1].args ).toContain( `-d` )
        expect( calls[1].args ).toContain( `session` )
        expect( calls[2].args.at( -1 ) ).toBe( `Enter` )
        expect( waits ).toEqual( [ 150 ] )

    } )

    it( `keeps dash-prefixed text separate from tmux options`, async () => {

        const { calls, runner, wait_fn } = collect_calls()

        await send_text( `session`, `-a note`, { runner, wait_fn } )

        expect( calls[0].args.slice( -2 ) ).toEqual( [ `--`, `-a note` ] )

    } )

    it( `pastes multi-line text through a bracketed paste buffer`, async () => {

        const { calls, runner, wait_fn } = collect_calls()
        const prompt = `line one\n\nline two`

        await send_text( `session`, prompt, { runner, wait_fn } )

        expect( calls.map( c => c.cmd ) ).toEqual( [ `tmux`, `tmux`, `tmux` ] )
        expect( calls[0].args ).toContain( `set-buffer` )
        expect( calls[0].args.at( -1 ) ).toBe( prompt )
        expect( calls[1].args ).toContain( `paste-buffer` )
        expect( calls[1].args ).toContain( `-pr` )
        expect( calls[1].args ).toContain( `-d` )
        expect( calls[1].args ).toContain( `session` )
        expect( calls[2].args.at( -1 ) ).toBe( `Enter` )

    } )

    it( `waits for the paste handler before sending Enter`, async () => {

        const { calls, runner } = collect_calls()
        let mark_wait_started
        let release_wait
        const wait_started = new Promise( resolve => { mark_wait_started = resolve } )
        const wait_fn = () => {
            mark_wait_started()
            return new Promise( resolve => { release_wait = resolve } )
        }
        const submission = send_text( `session`, `prompt`, { runner, wait_fn } )

        await wait_started

        expect( calls.length ).toBe( 2 )
        expect( calls.some( call => call.args.at( -1 ) === `Enter` ) ).toBe( false )

        release_wait()
        await submission

        expect( calls[2].args.at( -1 ) ).toBe( `Enter` )
        expect( calls.filter( call => call.args.at( -1 ) === `Enter` ).length ).toBe( 1 )

    } )

} )
