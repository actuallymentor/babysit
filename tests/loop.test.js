import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { apply_loop } from '../src/modes/loop.js'

const make_rules = () => [ {
    on: { type: `idle` },
    do: `old action`,
    timeout_s: 30,
} ]

describe( `apply_loop`, () => {

    it( `keeps project LOOP.md available when host preferences are isolated`, () => {

        const workspace = mkdtempSync( join( tmpdir(), `babysit-loop-local-` ) )
        const local_loop = join( workspace, `LOOP.md` )
        writeFileSync( local_loop, `Project instructions` )

        try {
            const rules = make_rules()
            apply_loop( rules, workspace, { include_global_loop: false } )
            expect( rules[0].do ).toBe( local_loop )
            // The user's idle timeout survives the action override
            expect( rules[0].timeout_s ).toBe( 30 )
        } finally {
            rmSync( workspace, { recursive: true, force: true } )
        }

    } )

    it( `uses the built-in fallback without reading host ~/.agents/LOOP.md`, () => {

        const workspace = mkdtempSync( join( tmpdir(), `babysit-loop-isolated-` ) )

        try {
            const rules = make_rules()
            apply_loop( rules, workspace, { include_global_loop: false } )
            expect( rules[0].do ).toBe( `Keep going` )
        } finally {
            rmSync( workspace, { recursive: true, force: true } )
        }

    } )

    it( `keeps an explicit --config idle rule instead of LOOP.md`, () => {

        const workspace = mkdtempSync( join( tmpdir(), `babysit-loop-config-` ) )
        writeFileSync( join( workspace, `LOOP.md` ), `Project instructions` )

        try {
            const rules = make_rules()
            apply_loop( rules, workspace, { config_path: join( workspace, `errors.yaml` ) } )
            expect( rules[0].do ).toBe( `old action` )
        } finally {
            rmSync( workspace, { recursive: true, force: true } )
        }

    } )

    it( `still inserts the loop rule when the --config file has no idle rule`, () => {

        const workspace = mkdtempSync( join( tmpdir(), `babysit-loop-config-empty-` ) )

        try {
            const rules = []
            apply_loop( rules, workspace, { include_global_loop: false, config_path: join( workspace, `errors.yaml` ) } )
            expect( rules[0].do ).toBe( `Keep going` )
        } finally {
            rmSync( workspace, { recursive: true, force: true } )
        }

    } )

} )
