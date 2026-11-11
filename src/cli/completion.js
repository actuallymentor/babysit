import { SUPPORTED_AGENTS } from '../agents/index.js'
import { COMMANDS, FLAGS, dashed } from './registry.js'

// Words and flags that exist for the machinery, not for people
const INTERNAL_VERBS = new Set( [ `launch`, `start`, `launch_dir`, `__monitor` ] )
const INTERNAL_FLAGS = new Set( [ `boot`, `shutdown` ] )

const verbs = () => [
    ...SUPPORTED_AGENTS,
    ...COMMANDS.filter( command => !command.hidden && !command.context && !INTERNAL_VERBS.has( command.name ) ).map( command => command.name ),
]

// What follows each word: its own flags (agents take the launch flags), then its subcommands
const spellings = flag => [ dashed( flag.name ), flag.alias && dashed( flag.alias ) ].filter( Boolean )
const flags_of = verb => {
    const agent = SUPPORTED_AGENTS.includes( verb )
    return FLAGS
        .filter( flag => !INTERNAL_FLAGS.has( flag.name ) && ( flag.scope === `global` && !flag.commands || agent && flag.scope === `launch` || flag.commands?.includes( verb ) ) )
        .flatMap( spellings )
}
const subcommands_of = verb => Object.keys( COMMANDS.find( command => command.name === verb )?.subcommands || {} )

const words = verb => ( {
    verb,
    flags: flags_of( verb ),
    subs: subcommands_of( verb ),
} )

/** @returns {Array<{ verb: string, flags: string[], subs: string[] }>} Completion data for every word */
export const completion_words = () => verbs().map( words )

const BASH = () => `
_babysit() {
    local cur="\${COMP_WORDS[COMP_CWORD]}" verb="\${COMP_WORDS[1]}" subs flags choices
    if [ "$COMP_CWORD" -eq 1 ]; then
        COMPREPLY=( $(compgen -W "${ verbs().join( ` ` ) }" -- "$cur") )
        return
    fi
    case "$verb" in
${ completion_words().map( ( { verb, flags, subs } ) => `        ${ verb }) subs="${ subs.join( ` ` ) }"; flags="${ flags.join( ` ` ) }" ;;` ).join( `\n` ) }
    esac
    # Flags once a dash is typed; subcommands only as the second word
    case "$cur" in -*) choices="$flags" ;; *) [ "$COMP_CWORD" -eq 2 ] && choices="$subs" ;; esac
    COMPREPLY=( $(compgen -W "$choices" -- "$cur") )
}
complete -o default -F _babysit babysit sit`

const ZSH = () => `
_babysit() {
    local verb="\${words[2]}" subs flags choices
    if (( CURRENT == 2 )); then
        compadd -- ${ verbs().join( ` ` ) }
        return
    fi
    case "$verb" in
${ completion_words().map( ( { verb, flags, subs } ) => `        ${ verb }) subs=(${ subs.join( ` ` ) }); flags=(${ flags.join( ` ` ) }) ;;` ).join( `\n` ) }
    esac
    if [[ "$PREFIX" == -* ]]; then choices=($flags); elif (( CURRENT == 3 )); then choices=($subs); else choices=(); fi
    (( \${#choices} )) && compadd -- $choices || _files
}
(( $+functions[compdef] )) || { autoload -Uz compinit && compinit -u }
compdef _babysit babysit sit`

const FISH = () => `
complete -c sit -w babysit
complete -c babysit -f -n '__fish_use_subcommand' -a '${ verbs().join( ` ` ) }'
${ completion_words().flatMap( ( { verb, flags, subs } ) => [
    ...subs.map( sub => `complete -c babysit -f -n '__fish_seen_subcommand_from ${ verb }; and not __fish_seen_subcommand_from ${ subs.join( ` ` ) }' -a '${ sub }'` ),
    ...flags.map( flag => `complete -c babysit -n '__fish_seen_subcommand_from ${ verb }' ${ flag.startsWith( `--` ) ? `-l ${ flag.slice( 2 ) }` : `-s ${ flag.slice( 1 ) }` }` ),
] ).join( `\n` ) }`

/**
 * Tab completion for babysit's words, flags and subcommands, generated from the
 * registry so it cannot drift from the parser. Unknown positions fall back to
 * the shell's file completion.
 * @param {string} shell - bash, zsh or fish
 * @returns {string} Script to append to the shell-init output
 */
export const completion_script = shell => shell === `fish` ? FISH() : shell === `zsh` ? ZSH() : BASH()
