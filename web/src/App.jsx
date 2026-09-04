import { useEffect, useState } from 'react'
import { BrowserRouter } from 'react-router-dom'
import { api } from './modules/api.js'
import { activate_update, force_update, register_pwa } from './modules/pwa.js'
import { use_install } from './hooks/use_install.js'
import { AppFrame } from './components/molecules/AppFrame.jsx'
import { InstallPill } from './components/molecules/InstallPill.jsx'
import { LoginPage } from './components/pages/LoginPage.jsx'
import { Routes } from './routes/Routes.jsx'

/** Owns authentication and PWA lifecycle state. */
export function App() {
    const [ identity, set_identity ] = useState( null )
    const [ is_loading, set_is_loading ] = useState( true )
    const [ has_update, set_has_update ] = useState( false )
    const { can_install, install } = use_install()

    useEffect( () => {
        const expire_authentication = () => set_identity( null )
        api( `/api/me` ).then( set_identity ).catch( () => set_identity( null ) ).finally( () => set_is_loading( false ) )
        register_pwa( set_has_update )
        window.addEventListener( `babysit-auth-expired`, expire_authentication )
        return () => window.removeEventListener( `babysit-auth-expired`, expire_authentication )
    }, [] )

    const login = async token => set_identity( await api( `/api/login`, { body: JSON.stringify( { token } ), method: `POST` } ) )
    const logout = async () => {
        await api( `/api/logout`, { body: `{}`, method: `POST` } )
        set_identity( null )
    }
    const update = async () => {
        await activate_update()
        set_has_update( false )
    }

    if( is_loading ) return null
    if( !identity ) return <LoginPage login={ login } />

    return <BrowserRouter>
        <AppFrame force_update={ force_update } has_update={ has_update } logout={ logout } update={ update }>
            <Routes role={ identity.role } />
        </AppFrame>
        <InstallPill can_install={ can_install } install={ install } />
    </BrowserRouter>
}
