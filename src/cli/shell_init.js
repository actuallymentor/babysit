import { existsSync, writeFileSync } from 'fs'
import { basename } from 'path'
import { WRAPPER_ENV } from '../utils/wrapper_env.js'

// A process cannot change its parent shell's directory. These wrappers hand
// babysit a file to write the target into, then `cd` there once it exits.
// The attach file does the same for tmux: babysit exits before the attach, so
// no idle babysit process (swapped out on a busy host) stalls the detach.
// The cd comes first: opening a session moves the shell to the session's base
// directory, and detaching leaves it there.
const POSIX = `babysit() {
    local babysit_cd_file babysit_attach_file babysit_status babysit_socket babysit_target
    babysit_cd_file="$(mktemp)" || { command babysit "$@"; return; }
    babysit_attach_file="$(mktemp)" || { rm -f "$babysit_cd_file"; command babysit "$@"; return; }
    BABYSIT_CD_FILE="$babysit_cd_file" BABYSIT_ATTACH_FILE="$babysit_attach_file" command babysit "$@"
    babysit_status=$?
    if [ -s "$babysit_cd_file" ]; then cd -- "$(cat "$babysit_cd_file")" || true; fi
    if [ -s "$babysit_attach_file" ]; then
        { IFS= read -r babysit_socket; IFS= read -r babysit_target; } < "$babysit_attach_file"
        command tmux -L "$babysit_socket" attach -t "$babysit_target"
    fi
    rm -f "$babysit_cd_file" "$babysit_attach_file"
    return $babysit_status
}`

const FISH = `function babysit
    set -l babysit_cd_file (mktemp); or begin; command babysit $argv; return; end
    set -l babysit_attach_file (mktemp); or begin; rm -f $babysit_cd_file; command babysit $argv; return; end
    BABYSIT_CD_FILE=$babysit_cd_file BABYSIT_ATTACH_FILE=$babysit_attach_file command babysit $argv
    set -l babysit_status $status
    test -s $babysit_cd_file; and cd (cat $babysit_cd_file)
    if test -s $babysit_attach_file
        set -l babysit_attach (cat $babysit_attach_file)
        command tmux -L $babysit_attach[1] attach -t $babysit_attach[2]
    end
    rm -f $babysit_cd_file $babysit_attach_file
    return $babysit_status
end`

export const SHELLS = [ `bash`, `zsh`, `fish` ]

/**
 * The shell function that lets `babysit open` move this shell into the session's base directory.
 * @param {string} [shell] - bash, zsh or fish; defaults to $SHELL
 * @returns {string} Function source for `eval`
 */
export const shell_init_script = ( shell = basename( process.env.SHELL || `bash` ) ) => shell === `fish` ? FISH : POSIX

/** Print the wrapper: `eval "$(babysit shell-init)"` in ~/.bashrc or ~/.zshrc, `babysit shell-init fish | source` in fish. */
export const cmd_shell_init = cmd => console.log( shell_init_script( cmd.shell || undefined ) )

/**
 * On open, move the calling shell into the session's base directory (the
 * original workspace, never a clone). With the shell-init wrapper the path
 * goes to its file; without it, print the cd line.
 * @param {string|null} workspace - Directory the session was started from
 * @param {Object} [options]
 * @param {string} [options.cwd] - Shell's current directory
 * @param {Object} [options.env] - Environment carrying BABYSIT_CD_FILE
 * @param {Function} [options.write_file] - File writer seam
 * @returns {boolean} Whether the wrapper will cd
 */
export const follow_workspace = ( workspace, { cwd = process.cwd(), env = WRAPPER_ENV, write_file = writeFileSync } = {} ) => {

    if( !workspace || workspace === cwd || !existsSync( workspace ) ) return false

    // Only the wrapper's own temp file, so a stale inherited variable never creates one
    const cd_file = env.BABYSIT_CD_FILE
    if( cd_file && existsSync( cd_file ) ) {
        write_file( cd_file, workspace )
        return true
    }

    console.log( `Session directory: cd ${ JSON.stringify( workspace ) }  (eval "$(babysit shell-init)" in your shell rc to follow it automatically)` )
    return false

}
