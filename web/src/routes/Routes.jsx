import { Navigate, Route, Routes as RouterRoutes } from 'react-router-dom'
import { SessionPage } from '../components/pages/SessionPage.jsx'
import { SessionsPage } from '../components/pages/SessionsPage.jsx'

/** Maps authenticated application routes. */
export function Routes( { role } ) {
    return <RouterRoutes>
        <Route element={ <SessionsPage /> } path="/" />
        <Route element={ <SessionPage role={ role } /> } path="/sessions/:session_id" />
        <Route element={ <Navigate replace to="/" /> } path="*" />
    </RouterRoutes>
}
