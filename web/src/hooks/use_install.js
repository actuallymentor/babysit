import { useEffect, useState } from 'react'

const in_app_mode = () => window.matchMedia( `(display-mode: standalone)` ).matches || window.navigator.standalone === true

/** Tracks the browser's native PWA install prompt. */
export const use_install = () => {
    const [ install_prompt, set_install_prompt ] = useState( null )
    const [ is_installed, set_is_installed ] = useState( in_app_mode )

    useEffect( () => {
        const capture_prompt = event => {
            event.preventDefault()
            set_install_prompt( event )
        }
        const mark_installed = () => {
            set_is_installed( true )
            set_install_prompt( null )
        }

        window.addEventListener( `beforeinstallprompt`, capture_prompt )
        window.addEventListener( `appinstalled`, mark_installed )
        return () => {
            window.removeEventListener( `beforeinstallprompt`, capture_prompt )
            window.removeEventListener( `appinstalled`, mark_installed )
        }
    }, [] )

    const install = async () => {
        if( !install_prompt ) return
        await install_prompt.prompt()
        set_install_prompt( null )
    }

    return { can_install: Boolean( install_prompt ) && !is_installed, install }
}
