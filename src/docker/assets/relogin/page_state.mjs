/*
 * Pure page classifier for the Claude sign-in flow. The driver snapshots the
 * page into plain data (see `snapshot_page`) and acts on the returned state.
 * Text heuristics, not CSS classes: claude.ai restyles often, its wording less so.
 */

// Hosts the browser may act on. Anything else is `foreign`, never clicked.
export const FLOW_HOSTS = [ `claude.ai`, `claude.com`, `anthropic.com` ]

export const in_hosts = ( host = ``, hosts = FLOW_HOSTS ) => hosts
    .some( allowed => host === allowed || host.endsWith( `.${ allowed }` ) )

const CONSENT_BUTTON = /^(authorize|allow|approve)$/i
const EMAIL_BUTTON = /^continue with email$/i
const CHECK_EMAIL = /check your (email|inbox)|(sent|emailed) (you )?(a|an|the) (login |sign[- ]in |magic )?(link|code)/i
const CAPTCHA = /just a moment|verify you are human|are you a robot|checking your browser/i

/**
 * Classify one page snapshot.
 * @param {Object} page - { url, title, text, buttons, email_input, code_input, captcha_frame }
 * @returns {'callback'|'foreign'|'consent'|'email_code_entry'|'check_email'|'email_entry'|'captcha'|'unknown'} State
 */
export const classify_page = ( { url = ``, title = ``, text = ``, buttons = [], email_input = false, code_input = false, captcha_frame = false } ) => {

    let host = ``
    try {
        host = new URL( url ).hostname
    } catch {
        return `unknown`
    }

    // The CLI's own localhost listener took the code; it finishes from here
    if( [ `localhost`, `127.0.0.1` ].includes( host ) ) return `callback`

    if( !in_hosts( host ) ) return `foreign`

    // A visible challenge wins over any button behind it
    if( CAPTCHA.test( title ) || CAPTCHA.test( text.slice( 0, 500 ) ) ) return `captcha`

    if( buttons.some( label => CONSENT_BUTTON.test( label ) ) ) return `consent`
    if( code_input ) return `email_code_entry`
    if( CHECK_EMAIL.test( text ) ) return `check_email`
    if( email_input && buttons.some( label => EMAIL_BUTTON.test( label ) ) ) return `email_entry`

    // Cloudflare keeps an invisible widget on normal pages; its iframe alone
    // is a challenge only when nothing actionable is showing
    if( captcha_frame ) return `captcha`
    return `unknown`

}

/**
 * Snapshot the page into the plain data `classify_page` reads. Runs in the
 * browser via page.evaluate, so it must stay self-contained.
 * @returns {Object} Snapshot
 */
export const snapshot_page = () => {

    const visible = element => {
        const box = element.getBoundingClientRect()
        const style = getComputedStyle( element )
        return box.width > 0 && box.height > 0 && style.visibility !== `hidden` && style.display !== `none`
    }
    const inputs = [ ...document.querySelectorAll( `input` ) ].filter( visible )

    return {
        url: location.href,
        title: document.title,
        text: ( document.body?.innerText || `` ).slice( 0, 4000 ),
        buttons: [ ...document.querySelectorAll( `button, [role=button], input[type=submit]` ) ]
            .filter( visible )
            .map( button => ( button.innerText || button.value || button.getAttribute( `aria-label` ) || `` ).trim() )
            .filter( Boolean ),
        email_input: inputs.some( input => input.type === `email` || input.autocomplete === `email` ),
        code_input: inputs.some( input => input.autocomplete === `one-time-code` || /code/i.test( `${ input.name } ${ input.id } ${ input.placeholder }` ) ),
        captcha_frame: [ ...document.querySelectorAll( `iframe` ) ].some( frame => /challenges\.cloudflare\.com|captcha/i.test( frame.src ) ),
    }

}
