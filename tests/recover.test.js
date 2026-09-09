import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { recovery_arguments, recovery_candidates, select_recovery_sessions, session_lock_key, workspace_config_hash } from '../src/sessions/recovery.js'

describe( `recovery policy`, () => {

    it( `follows an original selector through failed and replacement launches`, () => {
        const records = [
            { babysit_id: `first`, superseded_by: `failed` },
            { babysit_id: `failed`, resumed_from: `first`, status: `failed` },
            { babysit_id: `active`, resumed_from: `failed` },
            { babysit_id: `unrelated` },
        ]
        expect( select_recovery_sessions( records, `first` ).map( row => row.babysit_id ) ).toEqual( [ `active` ] )
    } )

    it( `selects only the terminal launch in resume chains even before parent retirement`, () => {

        const sessions = [
            { babysit_id: `original`, expected_open: true },
            { babysit_id: `resumed`, resumed_from: `original`, expected_open: true },
            { babysit_id: `latest`, resumed_from: `resumed`, expected_open: true },
            { babysit_id: `unrelated`, expected_open: false },
            { babysit_id: `retired`, superseded_by: `pruned-child`, expected_open: true },
        ]
        expect( recovery_candidates( sessions ).map( session => session.babysit_id ) ).toEqual( [ `latest`, `unrelated` ] )

    } )

    it( `preserves explicit model and effort while rejecting unsaved options`, () => {

        const agent = { name: `codex`, defaults: { model: `default-model` } }
        expect( recovery_arguments( agent, [ `--model=chosen`, `--effort`, `high` ] ) ).toEqual( {
            args: [ `--model`, `chosen`, `--effort`, `high` ], unsupported: false,
        } )
        const unsafe = recovery_arguments( agent, [ `--custom-token`, `secret`, `positional prompt` ] )
        expect( unsafe.unsupported ).toBe( true )
        expect( unsafe.args ).toEqual( [ `--model`, `default-model` ] )

    } )

    it( `snapshots the mode-dependent default model and rejects incomplete options`, () => {

        const agent = { name: `codex`, defaults: { model: ( { mode } ) => mode.yolo ? `fast` : `careful` } }
        expect( recovery_arguments( agent, [], { yolo: true } ).args ).toEqual( [ `--model`, `fast` ] )
        expect( recovery_arguments( agent, [ `--effort` ] ).unsupported ).toBe( true )

    } )

    it( `canonicalizes workspace aliases and detects config changes without storing contents`, () => {

        const directory = mkdtempSync( join( tmpdir(), `babysit-recovery-policy-` ) )
        const alias = `${ directory }-alias`
        try {
            symlinkSync( directory, alias )
            expect( session_lock_key( { agent: `codex`, pwd: alias } ) ).toBe( session_lock_key( { agent: `codex`, pwd: directory } ) )
            expect( workspace_config_hash( directory ) ).toBeNull()
            writeFileSync( join( directory, `babysit.yaml` ), `command: secret-one` )
            const initial = workspace_config_hash( directory )
            expect( initial ).toMatch( /^[a-f0-9]{64}$/ )
            writeFileSync( join( directory, `babysit.yaml` ), `command: secret-two` )
            expect( workspace_config_hash( directory ) ).not.toBe( initial )
        } finally {
            rmSync( alias, { force: true } )
            rmSync( directory, { recursive: true, force: true } )
        }

    } )

} )
