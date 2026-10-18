import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { BookOpen, ChevronRight, Download, LogOut, Menu as MenuIcon, Minus, Plus, RefreshCw, X } from 'lucide-react'
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
    background: color-mix(in srgb, var(--background) 92%, transparent);
    backdrop-filter: blur(8px);
    display: flex;
    gap: 0.5rem;
    justify-content: space-between;
    margin: 0 -1rem 1.5rem;
    min-height: 3.75rem;
    padding: env(safe-area-inset-top) 1rem 0;
    position: sticky;
    top: 0;
    z-index: 2;
`

const Brand = styled( Link )`
    align-items: center;
    border-radius: 0.5rem;
    color: var(--text);
    display: inline-flex;
    font-family: 'Montserrat Variable', system-ui, sans-serif;
    font-size: 1.125rem;
    gap: 0.5rem;
    min-height: 2.75rem;
    text-decoration: none;

    img { height: 1.5rem; width: 1.5rem; }
`

const Actions = styled.div`
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    justify-content: flex-end;
`

const slide_in = keyframes`
    from { opacity: 0; transform: translateX(1.5rem); }
    to { opacity: 1; transform: translateX(0); }
`

const Menu = styled.dialog`
    background: var(--surface);
    border: 0;
    border-left: 1px solid var(--line);
    color: var(--text);
    height: 100dvh;
    inset: 0;
    margin: 0 0 0 auto;
    max-height: none;
    max-width: 100%;
    overflow-y: auto;
    padding: max(0.75rem, env(safe-area-inset-top)) 1rem max(1rem, env(safe-area-inset-bottom));
    position: fixed;
    width: min(22rem, 100%);

    &[open] { animation: ${ slide_in } 280ms cubic-bezier(0.2, 0.8, 0.2, 1); display: flex; flex-direction: column; gap: 1.5rem; }
    &::backdrop { background: rgb(0 20 28 / 40%); }
    @media (prefers-reduced-motion: reduce) { &[open] { animation: none; } }
`

const MenuHeader = styled.div`
    align-items: center;
    display: flex;
    gap: 1rem;
    justify-content: space-between;
    min-height: 2.75rem;

    h2 { font-size: 1.125rem; margin: 0; }
`

const Group = styled.div`
    display: grid;
    gap: 1rem;

    > h3 {
        color: var(--muted);
        font-family: inherit;
        font-size: 0.8125rem;
        font-weight: 600;
        margin: 0;
    }

    label { display: grid; font-weight: 500; gap: 0.375rem; }
    select {
        appearance: auto;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        min-height: 2.75rem;
        padding: 0 0.625rem;
        width: 100%;
    }
`

const TextSize = styled.div`
    align-items: center;
    display: flex;
    font-weight: 500;
    gap: 0.5rem;
    justify-content: space-between;

    > div { align-items: center; display: flex; gap: 0.5rem; }
    output { color: var(--muted); font-variant-numeric: tabular-nums; min-width: 4ch; text-align: center; }
`

// Full-width rows with a subtle hover tint, for links and maintenance actions alike
const row = `
    align-items: center;
    background: none;
    border: 0;
    border-radius: 0.5rem;
    color: var(--text);
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: 0.75rem;
    margin: 0 -0.5rem;
    min-height: 2.75rem;
    padding: 0 0.5rem;
    text-align: left;
    text-decoration: none;
    transition: background 160ms ease;

    &:hover:not(:disabled) { background: var(--hover); }
    &:disabled { cursor: not-allowed; opacity: 0.5; }
    svg { color: var(--muted); flex-shrink: 0; height: 1.25rem; width: 1.25rem; }
    span { flex: 1; }
`

const MenuLink = styled( Link )`${ row }`
const MenuAction = styled.button`${ row }`

const Rows = styled.div`
    display: grid;
    gap: 0.125rem;
`

const Divider = styled.hr`
    border: 0;
    border-top: 1px solid var(--line);
    margin: 0;
    width: 100%;
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
            <Brand to="/"><img alt="" src="/icon.svg" />Babysit</Brand>
            <Actions>
                { has_update && <Button disabled={ is_working } onClick={ () => run_action( update ) }><RefreshCw aria-hidden="true" strokeWidth={ 1.5 } />Update ready</Button> }
                <Button $bare $icon aria-controls="app-menu" aria-expanded={ menu_open } aria-label="App menu" onClick={ () => set_menu_open( !menu_open ) } ref={ toggle }>
                    <MenuIcon aria-hidden="true" strokeWidth={ 1.5 } style={ { height: `1.25rem`, width: `1.25rem` } } />
                </Button>
            </Actions>
            <Menu aria-labelledby="app-menu-title" id="app-menu" onCancel={ () => set_menu_open( false ) } onClick={ dismiss_backdrop } ref={ menu }>
                <MenuHeader>
                    <h2 id="app-menu-title">Menu</h2>
                    <Button $bare $icon aria-label="Close menu" onClick={ () => set_menu_open( false ) }><X aria-hidden="true" strokeWidth={ 1.5 } style={ { height: `1.25rem`, width: `1.25rem` } } /></Button>
                </MenuHeader>

                <Group>
                    <h3>Appearance</h3>
                    <label>
                        Theme
                        <select aria-label="Theme" onChange={ event => reading.set_theme( event.target.value ) } value={ reading.theme }>
                            <option value="system">Match device</option>
                            <option value="light">Light</option>
                            <option value="dark">Dark</option>
                        </select>
                    </label>
                    <TextSize>
                        <span>Text size</span>
                        <div>
                            <Button $icon $quiet aria-label="Decrease text size" disabled={ reading.text_size === 100 } onClick={ () => reading.resize_text( -10 ) }><Minus aria-hidden="true" strokeWidth={ 1.5 } /></Button>
                            <output aria-live="polite">{ reading.text_size }%</output>
                            <Button $icon $quiet aria-label="Increase text size" disabled={ reading.text_size === 150 } onClick={ () => reading.resize_text( 10 ) }><Plus aria-hidden="true" strokeWidth={ 1.5 } /></Button>
                        </div>
                    </TextSize>
                </Group>

                <Divider />

                <Rows>
                    <MenuLink to="/api-docs"><BookOpen aria-hidden="true" strokeWidth={ 1.5 } /><span>API docs</span><ChevronRight aria-hidden="true" strokeWidth={ 1.5 } /></MenuLink>
                    { can_install && <MenuAction disabled={ is_working } onClick={ () => run_action( install ) }><Download aria-hidden="true" strokeWidth={ 1.5 } /><span>Install app</span></MenuAction> }
                    <MenuAction disabled={ is_working } onClick={ () => run_action( force_update ) } title="Clear the app cache and reload"><RefreshCw aria-hidden="true" strokeWidth={ 1.5 } /><span>Update app</span></MenuAction>
                    <MenuAction disabled={ is_working } onClick={ () => run_action( logout ) }><LogOut aria-hidden="true" strokeWidth={ 1.5 } /><span>Log out</span></MenuAction>
                </Rows>

                { action_error && <Notice $error role="alert">{ action_error }</Notice> }
            </Menu>
        </Header>
        <main>{ children }</main>
    </Shell>
}
