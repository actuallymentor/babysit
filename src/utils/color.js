const CODES = {
    dim: `2`,
    grey: `90`,
    green: `32`,
    yellow: `33`,
    orange: `38;5;208`,
    red: `31`,
}

/**
 * Whether terminal colors should be emitted. Honors NO_COLOR and dumb or
 * non-interactive outputs; FORCE_COLOR turns them on for tests.
 * @param {Object} [options]
 * @param {Object} [options.env=process.env] - Environment
 * @param {Object} [options.stream=process.stdout] - Output stream
 * @returns {boolean}
 */
export const color_enabled = ( { env = process.env, stream = process.stdout } = {} ) => {

    if( env.FORCE_COLOR && env.FORCE_COLOR !== `0` ) return true
    if( env.NO_COLOR || env.TERM === `dumb` ) return false
    return Boolean( stream?.isTTY )

}

/**
 * Wrap text in an ANSI color when colors are enabled.
 * @param {string} text - Text to paint
 * @param {string|null} color - One of dim, grey, green, yellow, orange, red
 * @param {Object} [options] - color_enabled options
 * @returns {string}
 */
export const paint = ( text, color, options = {} ) => {

    const code = color && CODES[ color ]
    return code && color_enabled( options ) ? `\x1b[${ code }m${ text }\x1b[0m` : String( text )

}
