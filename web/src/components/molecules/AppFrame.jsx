import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import styled, { keyframes } from 'styled-components'
import { Button } from '../atoms/Button.jsx'
import { Notice } from '../atoms/Notice.jsx'

const Shell = styled.div`
    margin: 0 auto;
    max-width: 64rem;
    min-height: 100dvh;
    padding: 0 1rem 6rem;
`

const Header = styled.header`
    align-items: center;
    background: var(--background);
    display: flex;
    gap: 0.5rem;
    justify-content: space-between;
    margin-bottom: 1.5rem;
    min-height: 4.5rem;
    padding-top: env(safe-area-inset-top);
    position: sticky;
    top: 0;
    z-index: 2;
`

const Brand = styled( Link )`
    color: var(--text);
    font-family: 'Montserrat Variable', system-ui, sans-serif;
    font-size: 1.25rem;
    font-weight: 500;
    text-decoration: none;
`

const Actions = styled.div`
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    justify-content: flex-end;
`

const slide_in = keyframes`
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
`

const Menu = styled.dialog`
    background: var(--surface);
    border: 0;
    border-left: 1px solid var(--border);
    color: var(--text);
    height: 100dvh;
    inset: 0;
    margin: 0 0 0 auto;
    max-height: none;
    max-width: 100%;
    overflow-y: auto;
    padding: max(1rem, env(safe-area-inset-top)) 1rem max(1rem, env(safe-area-inset-bottom));
    position: fixed;
    width: min(22rem, 100%);

    &[open] { animation: ${ slide_in } 220ms ease-out; display: flex; flex-direction: column; gap: 1.5rem; }
    &::backdrop { background: rgb(0 0 0 / 45%); }
    @media (prefers-reduced-motion: reduce) { &[open] { animation: none; } }

    label { display: grid; gap: 0.35rem; }
    select { border: 1px solid var(--border); border-radius: 0.3rem; min-height: 3rem; padding: 0.5em; width: 100%; }
`

const MenuHeader = styled.div`
    align-items: center;
    display: flex;
    gap: 1rem;
    justify-content: space-between;

    h2 { font-size: 1.25rem; margin: 0; }
`

const TextSize = styled.div`
    display: grid;
    gap: 0.35rem;

    > div { align-items: center; display: flex; gap: 0.75rem; }
    output { min-width: 4ch; text-align: center; }
`

const MenuActions = styled.div`
    display: grid;
    gap: 0.5rem;
`

/** Keeps maintenance and reading controls together, outside the reply workflow. */
export function AppFrame( { children, has_update, logout, update, force_update, can_install, install, reading } ) {
    const [ menu_open, set_menu_open ] = useState( false )
    const [ action_error, set_action_error ] = useState( null )
    const [ is_working, set_is_working ] = useState( false )
    const menu = useRef( null )
    const toggle = useRef( null )
    const { pathname } = useLocation()

    useEffect( () => set_menu_open( false ), [ pathname ] )

    useEffect( () => {
        if( !menu_open ) return

        // Native modal behavior traps focus and keeps the underlying session inert.
        const previous_overflow = document.body.style.overflow
        document.body.style.overflow = `hidden`
        menu.current.showModal()
        const drawer = menu.current

        return () => {
            drawer.close()
            document.body.style.overflow = previous_overflow
            toggle.current?.focus()
        }
    }, [ menu_open ] )

    const dismiss_backdrop = event => {
        if( event.target !== menu.current ) return
        const { left, right, top, bottom } = menu.current.getBoundingClientRect()
        if( event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom ) set_menu_open( false )
    }

    const run_action = async action => {
        set_action_error( null )
        set_is_working( true )
        try {
            await action()
        } catch ( error ) {
            set_action_error( error.message )
            set_menu_open( true )
        } finally {
            set_is_working( false )
        }
    }

    return <Shell>
        <Header>
            <Brand to="/">Babysit</Brand>
            <Actions>
                { has_update && <Button disabled={ is_working } onClick={ () => run_action( update ) }>Update ready</Button> }
                <Button $quiet aria-controls="app-menu" aria-expanded={ menu_open } aria-label="App menu" onClick={ () => set_menu_open( !menu_open ) } ref={ toggle }>
                    <svg aria-hidden="true" fill="none" height="24" viewBox="0 0 24 24" width="24">
                        <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2" />
                    </svg>
                </Button>
            </Actions>
            <Menu aria-labelledby="app-menu-title" id="app-menu" onCancel={ () => set_menu_open( false ) } onClick={ dismiss_backdrop } ref={ menu }>
                <MenuHeader>
                    <h2 id="app-menu-title">App settings</h2>
                    <Button $quiet aria-label="Close menu" onClick={ () => set_menu_open( false ) }>×</Button>
                </MenuHeader>
                <label>
                    Theme
                    <select aria-label="Theme" onChange={ event => reading.set_theme( event.target.value ) } value={ reading.theme }>
                        <option value="system">System</option>
                        <option value="light">Light</option>
                        <option value="dark">Dark</option>
                    </select>
                </label>
                <TextSize>
                    <span>Text size</span>
                    <div>
                        <Button $quiet aria-label="Decrease text size" disabled={ reading.text_size === 100 } onClick={ () => reading.resize_text( -10 ) }>−</Button>
                        <output aria-live="polite">{ reading.text_size }%</output>
                        <Button $quiet aria-label="Increase text size" disabled={ reading.text_size === 150 } onClick={ () => reading.resize_text( 10 ) }>+</Button>
                    </div>
                </TextSize>
                <MenuActions>
                    { can_install && <Button $quiet disabled={ is_working } onClick={ () => run_action( install ) }>Install app</Button> }
                    <Button $quiet disabled={ is_working } onClick={ () => run_action( force_update ) } title="Clear the app cache and reload">Update app</Button>
                    <Button $quiet disabled={ is_working } onClick={ () => run_action( logout ) }>Log out</Button>
                </MenuActions>
                { action_error && <Notice $error role="alert">{ action_error }</Notice> }
            </Menu>
        </Header>
        <main>{ children }</main>
    </Shell>
}
