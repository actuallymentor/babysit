import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import styled from 'styled-components'
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

const Menu = styled.div`
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.35rem;
    display: grid;
    gap: 1.5rem;
    max-height: calc(100dvh - 6rem - env(safe-area-inset-top));
    overflow-y: auto;
    padding: 1rem;
    position: absolute;
    right: 0;
    top: 100%;
    width: min(22rem, 100%);

    label { display: grid; gap: 0.35rem; }
    select { border: 1px solid var(--border); border-radius: 0.3rem; min-height: 3rem; padding: 0.5em; width: 100%; }
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
    const header = useRef( null )
    const toggle = useRef( null )
    const { pathname } = useLocation()

    useEffect( () => set_menu_open( false ), [ pathname ] )

    useEffect( () => {
        if( !menu_open ) return

        const dismiss_outside = event => {
            if( !header.current?.contains( event.target ) ) set_menu_open( false )
        }
        const dismiss_escape = event => {
            if( event.key !== `Escape` ) return
            set_menu_open( false )
            toggle.current?.focus()
        }

        document.addEventListener( `pointerdown`, dismiss_outside )
        document.addEventListener( `focusin`, dismiss_outside )
        document.addEventListener( `keydown`, dismiss_escape )
        return () => {
            document.removeEventListener( `pointerdown`, dismiss_outside )
            document.removeEventListener( `focusin`, dismiss_outside )
            document.removeEventListener( `keydown`, dismiss_escape )
        }
    }, [ menu_open ] )

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
        <Header ref={ header }>
            <Brand to="/">Babysit</Brand>
            <Actions>
                { has_update && <Button disabled={ is_working } onClick={ () => run_action( update ) }>Update ready</Button> }
                <Button $quiet aria-controls="app-menu" aria-expanded={ menu_open } aria-label="App menu" onClick={ () => set_menu_open( !menu_open ) } ref={ toggle }>
                    <svg aria-hidden="true" fill="none" height="24" viewBox="0 0 24 24" width="24">
                        <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2" />
                    </svg>
                </Button>
            </Actions>
            { menu_open && <Menu aria-label="App settings" id="app-menu" role="region">
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
            </Menu> }
        </Header>
        <main>{ children }</main>
    </Shell>
}
