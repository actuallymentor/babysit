import { describe, it, expect } from 'bun:test'
import { PassThrough } from 'node:stream'

import { form_menu } from '../src/cli/form.js'

const down = `\x1b[B`
const SECRET = `hunter2-do-not-leak`

// A fake raw TTY pair that records everything drawn
const open_form = options => {

    const input = new PassThrough()
    const output = new PassThrough()
    let rendered = ``
    input.isTTY = true
    input.setRawMode = raw => input.isRaw = raw
    output.isTTY = true
    output.columns = 100
    output.on( `data`, chunk => rendered += chunk.toString() )

    const result = form_menu( { title: `Add a PC`, input, output, ...options } )
    return { result, type: text => input.write( text ), rendered: () => rendered }

}

const fields = [
    { key: `name`, label: `Name` },
    { key: `host`, label: `Host`, value: `10.0.0.5` },
    { key: `password`, label: `Password`, secret: true },
]

describe( `form_menu`, () => {

    it( `Enter walks the fields, the last Enter submits, secrets never render`, async () => {
        const form = open_form( { fields } )
        form.type( `laptop\r\r${ SECRET }\r` )
        expect( await form.result ).toEqual( { name: `laptop`, host: `10.0.0.5`, password: SECRET } )
        expect( form.rendered() ).not.toContain( SECRET )
        expect( form.rendered() ).toContain( `•••` )
    } )

    it( `starts on the first empty field and edits prefilled text`, async () => {
        const form = open_form( { fields: [ { key: `name`, label: `Name`, value: `pc` }, { key: `user`, label: `User` } ] } )
        form.type( `me\x1b[A\x7f\x7fbox\r\r` )
        expect( await form.result ).toEqual( { name: `box`, user: `me` } )
    } )

    it( `shows validation errors under the form and keeps it open`, async () => {
        const form = open_form( { fields, validate: values => {
            if( !values.password ) throw new Error( `Password: empty` )
        } } )
        form.type( `laptop\r\r\r` )
        await new Promise( resolve => setTimeout( resolve, 20 ) )
        expect( form.rendered() ).toContain( `Password: empty` )
        form.type( `x\r` )
        expect( ( await form.result ).password ).toBe( `x` )
    } )

    it( `Esc cancels, and notes show under the key hint`, async () => {
        const form = open_form( { fields, notes: [ `Turn on OpenSSH` ] } )
        form.type( `${ down }\x1b` )
        await new Promise( resolve => setTimeout( resolve, 50 ) )
        expect( form.rendered() ).toContain( `Turn on OpenSSH` )
        expect( await form.result ).toBeNull()
    } )

    it( `refuses without a terminal`, async () => {
        await expect( form_menu( { title: `x`, fields, input: new PassThrough(), output: new PassThrough() } ) ).rejects.toThrow( `interactive terminal` )
    } )

} )
