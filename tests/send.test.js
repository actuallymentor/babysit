import { describe, it, expect } from 'bun:test'
import { send_text } from '../src/tmux/send.js'

const collect_calls = () => {

    const calls = []
    const runner = async ( cmd, args ) => {
        calls.push( { cmd, args } )
        return ``
    }

    return { calls, runner }

}

describe( `send_text`, () => {

    it( `sends single-line text literally and submits it`, async () => {

        const { calls, runner } = collect_calls()

        await send_text( `session`, `Use $HOME wisely`, { runner } )

        expect( calls.map( c => c.cmd ) ).toEqual( [ `tmux`, `tmux` ] )
        expect( calls[0].args ).toContain( `send-keys` )
        expect( calls[0].args ).toContain( `-l` )
        expect( calls[0].args.at( -1 ) ).toBe( `Use $HOME wisely` )
        expect( calls[1].args.at( -1 ) ).toBe( `Enter` )

    } )

    it( `pastes multi-line text through a bracketed paste buffer`, async () => {

        const { calls, runner } = collect_calls()
        const prompt = `line one\n\nline two`

        await send_text( `session`, prompt, { runner } )

        expect( calls.map( c => c.cmd ) ).toEqual( [ `tmux`, `tmux`, `tmux` ] )
        expect( calls[0].args ).toContain( `set-buffer` )
        expect( calls[0].args.at( -1 ) ).toBe( prompt )
        expect( calls[1].args ).toContain( `paste-buffer` )
        expect( calls[1].args ).toContain( `-pr` )
        expect( calls[1].args ).toContain( `-d` )
        expect( calls[1].args ).toContain( `session` )
        expect( calls[2].args.at( -1 ) ).toBe( `Enter` )

    } )

} )
