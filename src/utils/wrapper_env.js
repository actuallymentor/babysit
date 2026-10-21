/**
 * The shell-init wrapper's handoff files (cd target, tmux attach target)
 * belong to this one invocation. They leave process.env at load, before
 * anything spawns, so no child inherits a live path: a tmux server started
 * here would otherwise hand it to every pane, and a babysit run there would
 * write into this wrapper's files.
 */
const take = name => {
    const value = process.env[ name ]
    delete process.env[ name ]
    return value
}

export const WRAPPER_ENV = {
    BABYSIT_CD_FILE: take( `BABYSIT_CD_FILE` ),
    BABYSIT_ATTACH_FILE: take( `BABYSIT_ATTACH_FILE` ),
}
