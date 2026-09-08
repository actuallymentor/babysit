import { useEffect, useLayoutEffect, useState } from 'react'

const storage_key = `babysit-reading-preferences`
const defaults = { theme: `system`, text_size: 100 }

const read_preferences = () => {
    try {
        const saved = JSON.parse( localStorage.getItem( storage_key ) )
        return {
            theme: [ `system`, `light`, `dark` ].includes( saved?.theme ) ? saved.theme : defaults.theme,
            text_size: [ 100, 110, 120, 130, 140, 150 ].includes( saved?.text_size ) ? saved.text_size : defaults.text_size,
        }
    } catch {
        return defaults
    }
}

/** Stores appearance choices only; browser font preferences remain the baseline. */
export const use_reading_preferences = () => {
    const [ preferences, set_preferences ] = useState( read_preferences )

    useLayoutEffect( () => {
        document.documentElement.dataset.theme = preferences.theme
        document.documentElement.style.fontSize = `${ preferences.text_size }%`

        // Storage can be unavailable in private or restricted browser contexts.
        try {
            localStorage.setItem( storage_key, JSON.stringify( preferences ) )
        } catch { /* Keep the current session's preferences usable. */ }
    }, [ preferences ] )

    useEffect( () => {
        const system_theme = window.matchMedia( `(prefers-color-scheme: dark)` )
        const update_browser_color = () => {
            const is_dark = preferences.theme === `dark` || preferences.theme === `system` && system_theme.matches
            document.querySelector( `meta[name="theme-color"]` )?.setAttribute( `content`, is_dark ? `#141c24` : `#fafbfc` )
        }

        update_browser_color()
        system_theme.addEventListener( `change`, update_browser_color )
        return () => system_theme.removeEventListener( `change`, update_browser_color )
    }, [ preferences.theme ] )

    const set_theme = theme => set_preferences( previous => ( { ...previous, theme } ) )
    const resize_text = delta => set_preferences( previous => ( {
        ...previous,
        text_size: Math.max( 100, Math.min( 150, previous.text_size + delta ) ),
    } ) )

    return { ...preferences, set_theme, resize_text }
}
