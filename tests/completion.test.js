import { describe, it, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { completion_script, completion_words } from '../src/cli/completion.js'
import { shell_init_script } from '../src/cli/shell_init.js'

const find = verb => completion_words().find( word => word.verb === verb )

describe( `completion data`, () => {

    it( `lists agents and commands, not internals`, () => {
        const verbs = completion_words().map( word => word.verb )
        expect( verbs ).toEqual( expect.arrayContaining( [ `claude`, `codex`, `open`, `restart`, `watch` ] ) )
        expect( verbs ).not.toContain( `__monitor` )
        expect( verbs ).not.toContain( `effort` )
    } )

    it( `gives each word its own flags and subcommands`, () => {
        expect( find( `restart` ).flags ).toEqual( expect.arrayContaining( [ `--force`, `--detach` ] ) )
        expect( find( `list` ).flags ).not.toContain( `--force` )
        expect( find( `auth` ).subs ).toEqual( expect.arrayContaining( [ `init`, `check` ] ) )
        expect( find( `codex` ).flags ).toContain( `--yolo` )
        expect( find( `open` ).flags ).not.toContain( `--yolo` )
    } )

} )

describe( `bash completion`, () => {

    const complete = line => {
        const words = line.split( ` ` )
        const script = `${ completion_script( `bash` ) }
COMP_WORDS=(${ words.map( word => `'${ word }'` ).join( ` ` ) }); COMP_CWORD=${ words.length - 1 }; COMPREPLY=(); _babysit; echo "\${COMPREPLY[*]}"`
        return spawnSync( `bash`, [ `--norc`, `-c`, script ], { encoding: `utf8` } ).stdout.trim()
    }

    it( `expands a verb prefix`, () => {
        expect( complete( `babysit res` ) ).toBe( `resume restart` )
        expect( complete( `babysit ope` ).split( ` ` ).sort() ).toEqual( [ `open`, `opencode` ] )
    } )

    it( `offers flags only after a dash, subcommands as the second word`, () => {
        expect( complete( `babysit restart --f` ) ).toBe( `--force` )
        expect( complete( `babysit restart ` ) ).toBe( `` )
        expect( complete( `babysit auth i` ) ).toBe( `init` )
    } )

} )

describe( `shell_init_script`, () => {

    it( `carries the completion for the shell asked for`, () => {
        expect( shell_init_script( `bash` ) ).toContain( `complete -o default -F _babysit babysit` )
        expect( shell_init_script( `zsh` ) ).toContain( `compdef _babysit babysit` )
        expect( shell_init_script( `fish` ) ).toContain( `complete -c babysit` )
    } )

    it( `defines sit as a short name for the wrapper, with the same completion`, () => {
        expect( shell_init_script( `bash` ) ).toContain( `sit() { babysit "$@"; }` )
        expect( shell_init_script( `bash` ) ).toContain( `babysit sit` )
        expect( shell_init_script( `fish` ) ).toContain( `function sit; babysit $argv; end` )
        expect( shell_init_script( `fish` ) ).toContain( `complete -c sit -w babysit` )
    } )

} )
