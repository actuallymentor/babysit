import { Navigate, Route, Routes as RouterRoutes, useParams } from 'react-router-dom'
import { SessionPage } from '../components/pages/SessionPage.jsx'
import { SessionsPage } from '../components/pages/SessionsPage.jsx'

// Remount session state when navigation changes the destination.
const SessionRoute = ( { role } ) => {
    const { session_id } = useParams()
    return <SessionPage key={ session_id } role={ role } />
}

/** Maps authenticated application routes. */
export function Routes( { role } ) {
    return <RouterRoutes>
        <Route element={ <SessionsPage role={ role } /> } path="/" />
        <Route element={ <SessionRoute role={ role } /> } path="/sessions/:session_id" />
        <Route element={ <Navigate replace to="/" /> } path="*" />
    </RouterRoutes>
}
