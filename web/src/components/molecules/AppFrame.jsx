import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { Button } from '../atoms/Button.jsx'

const Shell = styled.div`
    margin: 0 auto;
    max-width: 64rem;
    min-height: 100dvh;
    padding: 0 1rem 8rem;
`

const Header = styled.header`
    align-items: center;
    backdrop-filter: blur(12px);
    background: rgba(245, 243, 238, 0.94);
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    justify-content: space-between;
    margin: 0 -1rem 1.5rem;
    min-height: 4.5rem;
    padding: env(safe-area-inset-top) 1rem 0;
    position: sticky;
    top: 0;
    z-index: 2;
`

const Brand = styled( Link )`
    color: #15221f;
    font-family: 'Montserrat Variable', system-ui, sans-serif;
    font-size: 1.25rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-decoration: none;
`

const Actions = styled.div`
    align-items: center;
    display: flex;
    gap: 0.5rem;

    ${ Button } { min-height: 2.75rem; padding-inline: 0.8em; }
`

const UpdateBadge = styled.button`
    background: #7ec0d0;
    border: 0;
    border-radius: 999rem;
    color: #15221f;
    cursor: pointer;
    font: inherit;
    font-weight: 800;
    min-height: 2.75rem;
    padding: 0.55em 0.9em;
`

/** Provides stable app navigation and update controls. */
export function AppFrame( { children, has_update, logout, update, force_update } ) {
    return <Shell>
        <Header>
            <Brand to="/">Babysit</Brand>
            <Actions>
                { has_update && <UpdateBadge onClick={ update }>Update ready</UpdateBadge> }
                <Button $quiet onClick={ force_update } title="Clear the app cache and reload">Update app</Button>
                <Button $quiet onClick={ logout }>Log out</Button>
            </Actions>
        </Header>
        <main>{ children }</main>
    </Shell>
}
