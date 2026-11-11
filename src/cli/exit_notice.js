// What a session run prints after its attach returns (re-attach / resume hint).
// On a terminal the interactive watch opens right after, so the hint rides in
// as its first notice instead of scrolling past; scripts keep the plain print.

let held = null

/** @returns {boolean} Whether the interactive watch will follow an attach (both streams are TTYs) */
export const watch_follows = () => Boolean( process.stdin.isTTY && process.stdout.isTTY )

/**
 * Show a post-attach hint: held for the watch on a terminal, printed otherwise.
 * @param {string} text - Hint, shown as one line in the watch
 * @param {Object} [options]
 * @param {Function} [options.print] - Plain output seam
 * @param {boolean} [options.follows] - Whether the watch follows
 */
export const post_attach_hint = ( text, { print = console.log, follows = watch_follows() } = {} ) => {
    if( follows ) held = text
    else print( `\n${ text }\n` )
}

/** @returns {string|null} The held hint, once */
export const take_exit_notice = () => {
    const text = held
    held = null
    return text
}
