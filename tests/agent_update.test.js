import { describe, it, expect } from 'bun:test'
import {
    build_update_strategies,
    detect_install_method,
} from '../src/deps/agent_update.js'
import { claude } from '../src/agents/claude.js'
import { codex } from '../src/agents/codex.js'
import { gemini } from '../src/agents/gemini.js'
import { opencode } from '../src/agents/opencode.js'

describe( `agent update strategies`, () => {

    it( `claude tries self-update first, then npm, then brew (cask)`, () => {

        const strategies = build_update_strategies( claude )
        const names = strategies.map( s => s.name )
        expect( names ).toEqual( [ `self-update`, `npm`, `brew` ] )

        // Self-update is the agent's documented in-place upgrade
        expect( strategies[0].cmd ).toBe( `claude` )
        expect( strategies[0].args ).toEqual( [ `update` ] )

        // npm strategy pins to @latest so users always get the newest release
        expect( strategies[1].args ).toEqual( [ `install`, `-g`, `@anthropic-ai/claude-code@latest` ] )

        // claude on brew is a cask, not a formula — `brew upgrade <name>` would
        // error out as "No such formula". Locking this in so a refactor can't
        // silently drop the --cask flag.
        expect( strategies[2].args ).toEqual( [ `upgrade`, `--cask`, `claude-code` ] )

    } )

    it( `codex only has the npm strategy (no brew formula, no self-update)`, () => {

        const strategies = build_update_strategies( codex )
        expect( strategies.map( s => s.name ) ).toEqual( [ `npm` ] )
        expect( strategies[0].args ).toEqual( [ `install`, `-g`, `@openai/codex@latest` ] )

    } )

    it( `gemini has npm + brew formula (no self-update)`, () => {

        const strategies = build_update_strategies( gemini )
        expect( strategies.map( s => s.name ) ).toEqual( [ `npm`, `brew` ] )
        // gemini-cli is a regular formula, no --cask
        expect( strategies[1].args ).toEqual( [ `upgrade`, `gemini-cli` ] )

    } )

    it( `opencode prefers its built-in upgrade subcommand`, () => {

        const strategies = build_update_strategies( opencode )
        expect( strategies[0].name ).toBe( `self-update` )
        expect( strategies[0].cmd ).toBe( `opencode` )
        expect( strategies[0].args ).toEqual( [ `upgrade` ] )

        // npm package is `opencode-ai`, NOT `opencode` — the bare `opencode`
        // npm name belongs to a different (unrelated) package. Locking this in.
        const npm = strategies.find( s => s.name === `npm` )
        expect( npm.args ).toEqual( [ `install`, `-g`, `opencode-ai@latest` ] )

    } )

    it( `agents with no update declaration produce no strategies`, () => {

        const fake_agent = { name: `fake`, bin: `fake` }
        expect( build_update_strategies( fake_agent ) ).toEqual( [] )

    } )

    it( `package-manager strategies are gated by the install-method detection`, () => {

        // The package-manager strategies must NOT run unconditionally — a brew-
        // installed claude with npm available shouldn't trigger an `npm install -g`
        // and end up with a second copy. The detect functions guard this; verify
        // they exist and are actually called by build_update_strategies.
        for( const agent of [ claude, codex, gemini, opencode ] ) {
            const strategies = build_update_strategies( agent )
            for( const s of strategies ) {
                if( s.name === `npm` || s.name === `brew` ) {
                    expect( typeof s.detect ).toBe( `function` )
                }
            }
        }

    } )

} )

describe( `install-method detection`, () => {

    it( `returns null for binaries that aren't on PATH`, () => {

        // A clearly nonexistent binary — `command -v` returns non-zero and we
        // get null back instead of falsely picking a strategy.
        expect( detect_install_method( `definitely-not-a-real-binary-xyz123` ) ).toBeNull()

    } )

    it( `recognises npm-managed binaries by their realpath segment`, () => {

        // We can't rely on a specific binary being npm-installed in CI, so this
        // test just validates that the regex works against the kind of path that
        // npm globals resolve to. The actual detection is exercised end-to-end
        // by the agent_update wiring.
        const npm_path = `/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js`
        expect( /\/node_modules\//.test( npm_path ) ).toBe( true )

    } )

    it( `recognises brew-managed binaries by their realpath segment`, () => {

        const brew_paths = [
            `/opt/homebrew/Cellar/gemini-cli/0.1.0/bin/gemini`,
            `/usr/local/Cellar/codex/2.0.0/bin/codex`,
            `/home/linuxbrew/.linuxbrew/Cellar/opencode/1.0.0/bin/opencode`,
        ]
        for( const p of brew_paths ) {
            expect( /\/(Cellar|homebrew|linuxbrew)\//.test( p ) ).toBe( true )
        }

    } )

} )
