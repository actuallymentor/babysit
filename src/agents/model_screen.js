// The model an agent's own screen says it is using, for the tmux status bar.
// Claude names it in its header (scrolls away) and in babysit's statusline
// (`◆ Opus 5.5`, always visible); Codex keeps `<model> <effort> · <dir>` in its
// footer once a turn has run. null when the screen shows none (keep the last seen).

const CLAUDE_MODEL = /(?:Opus|Sonnet|Haiku|Fable)\s+\d[\d.]*/
const TAIL_LINES = 8

const lines = screen => String( screen ).split( `\n` )
const tail = screen => lines( screen ).slice( -TAIL_LINES )

const FROM_SCREEN = {

    // Header: `▝▜██████▀  Opus 5.5 · Claude API`; statusline: `... ◆ Opus 5.5 ...`
    claude: screen => {
        const status = tail( screen ).map( line => line.match( new RegExp( `◆ (${ CLAUDE_MODEL.source })` ) ) ).find( Boolean )
        const header = lines( screen ).slice( 0, 12 ).map( line => line.match( new RegExp( `^[\\s▐▛▜▝▘█▀▄]*(${ CLAUDE_MODEL.source })\\s+·` ) ) ).find( Boolean )
        return ( status || header )?.[1] || null
    },

    // Footer: `GPT-6.1-Sol default · /path · last prompt`
    codex: screen => tail( screen )
        .map( line => line.match( /^\s*(\S.*?)\s+(?:default|minimal|low|medium|high|xhigh)\s+·\s/ ) )
        .find( Boolean )?.[1] || null,

}

/**
 * @param {string} agent - Agent name
 * @param {string} screen - Visible pane text, ANSI stripped
 * @returns {string|null} Model as the agent prints it
 */
export const model_from_screen = ( agent, screen ) => FROM_SCREEN[ agent ]?.( screen ) || null
