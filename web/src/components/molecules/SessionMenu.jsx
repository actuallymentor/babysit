import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Archive, Ellipsis, ExternalLink, MailOpen, RotateCcw, Snowflake, Sun } from 'lucide-react'
import styled from 'styled-components'
import { Button } from '../atoms/Button.jsx'
import { api } from '../../modules/api.js'

// How long a result is followed on the host before the menu stops asking
const FOLLOW_MS = 30_000
const FOLLOW_EVERY_MS = 1_500

const Anchor = styled.div`
    flex-shrink: 0;
    position: relative;
`

const Menu = styled.div`
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 0.75rem;
    box-shadow: 0 8px 24px rgb(0 0 0 / 14%);
    display: grid;
    min-width: 13.5rem;
    padding: 0.25rem;
    position: absolute;
    right: 0;
    top: calc(100% + 0.25rem);
    z-index: 10;
`

const Note = styled.p`
    color: var(--muted);
    font-size: 0.8125rem;
    margin: 0;
    max-width: 15rem;
    padding: 0.5rem 0.75rem;
`

// Whole-row targets, 44px tall for touch
const Item = styled.button`
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 0.5rem;
    color: ${ ( { $danger } ) => $danger ? `var(--danger)` : `var(--text)` };
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: 0.9375rem;
    gap: 0.625rem;
    min-height: 2.75rem;
    padding: 0 0.75rem;
    text-align: left;

    svg { color: ${ ( { $danger } ) => $danger ? `var(--danger)` : `var(--muted)` }; flex-shrink: 0; height: 1rem; width: 1rem; }
    small { color: var(--muted); display: block; font-size: 0.8125rem; }

    &:hover, &:focus-visible { background: var(--hover); outline: none; }
`

/**
 * The menu entries a session offers, mirroring the `babysit watch` shortcuts:
 * enter open, space mark read, e idle list, f freeze, r restart. Only actions
 * the session's monitor publishes are offered: older monitors take none.
 * @param {Object} session - Session summary
 * @returns {Array<{ action: string, label: string, icon: Function }>}
 */
export const menu_items = session => {
    const frozen = session.status === `frozen`
    const idle = session.activity === `idle` && !session.status

    return [
        { action: `open`, label: `Open`, icon: ExternalLink },
        session.unread && { action: `read`, label: `Mark read`, icon: MailOpen },
        idle && !session.parked && { action: `shelve`, label: `Move to idle list`, icon: Archive },
        frozen
            ? { action: `unfreeze`, label: `Unfreeze`, icon: Sun }
            : { action: `freeze`, label: `Freeze`, icon: Snowflake },
        { action: `restart`, label: `Restart`, icon: RotateCcw, confirm: !idle },
    ].filter( item => item && ( item.action === `open` || session.actions?.includes( item.action ) ) )
}

const DOING = { read: `Marking read`, shelve: `Moving to the idle list`, freeze: `Freezing`, unfreeze: `Unfreezing`, restart: `Restarting`, force_restart: `Restarting` }

/**
 * Per-session `…` menu. Actions travel to the host monitor as bridge requests;
 * `report` hears progress and the host's final word.
 * @param {Object} props
 * @param {Object} props.session - Session summary
 * @param {Function} props.report - (text, { error }) => void
 * @param {Function} [props.refresh] - Called once a request is queued, to refresh
 */
export function SessionMenu( { session, report, refresh } ) {
    const [ open, set_open ] = useState( false )
    const [ armed, set_armed ] = useState( false )
    const anchor_ref = useRef( null )
    const trigger_ref = useRef( null )
    const menu_ref = useRef( null )
    const follow = useRef( null )
    const navigate = useNavigate()
    const items = menu_items( session )

    const close = ( { focus = true } = {} ) => {
        set_open( false )
        set_armed( false )
        if( focus ) trigger_ref.current?.focus()
    }

    // Outside click and Escape close; arrows walk the items
    useEffect( () => {
        if( !open ) return
        menu_ref.current?.querySelector( `button` )?.focus()

        const outside = event => !anchor_ref.current?.contains( event.target ) && close( { focus: false } )
        const keys = event => {
            if( event.key === `Escape` ) return close()
            if( ![ `ArrowDown`, `ArrowUp` ].includes( event.key ) ) return
            event.preventDefault()
            const buttons = [ ...menu_ref.current?.querySelectorAll( `button` ) || [] ]
            const at = buttons.indexOf( document.activeElement )
            const step = event.key === `ArrowDown` ? 1 : -1
            buttons[ ( at + step + buttons.length ) % buttons.length ]?.focus()
        }

        document.addEventListener( `pointerdown`, outside )
        document.addEventListener( `keydown`, keys )
        return () => {
            document.removeEventListener( `pointerdown`, outside )
            document.removeEventListener( `keydown`, keys )
        }
    }, [ open ] )

    useEffect( () => () => clearTimeout( follow.current ), [] )

    // Ask the host how the request went until it settles; a restart replaces the
    // session, so its page going away is the expected ending
    const follow_result = ( request_id, action, started = Date.now() ) => {
        follow.current = setTimeout( async () => {
            try {
                const { pending } = await api( `/api/sessions/${ session.session_id }` )
                const result = pending.find( entry => entry.request_id === request_id )
                const settled = result?.message && !result.message.endsWith( `…` ) || [ `rejected`, `failed`, `timed_out` ].includes( result?.status )
                if( result?.message ) report( `${ session.name }: ${ result.message }`, { error: [ `rejected`, `failed` ].includes( result.status ) } )
                if( result?.status === `timed_out` ) report( `${ session.name }: the host did not pick the request up`, { error: true } )
                if( settled ) return refresh?.()
            } catch ( error ) {
                if( error.status_code === 404 && action.endsWith( `restart` ) ) return report( `${ session.name } is restarting; it reappears once it is back` )
            }
            if( Date.now() - started < FOLLOW_MS ) follow_result( request_id, action, started )
        }, FOLLOW_EVERY_MS )
    }

    const choose = async item => {
        if( item.action === `open` ) return navigate( `/sessions/${ session.session_id }` )

        // Mid-turn work is cut off by a restart: ask twice, like rr in watch
        if( item.confirm && !armed ) return set_armed( true )

        // A confirmed restart may cut off a turn; a plain one lets the host refuse a busy session
        const action = item.confirm ? `force_restart` : item.action
        close()
        report( `${ DOING[ action ] } ${ session.name }…` )
        try {
            const { request_id } = await api( `/api/sessions/${ session.session_id }/actions`, {
                body: JSON.stringify( { action } ),
                method: `POST`,
            } )
            clearTimeout( follow.current )
            follow_result( request_id, action )
            refresh?.()
        } catch ( error ) {
            report( `${ session.name }: ${ error.message }`, { error: true } )
        }
    }

    return <Anchor ref={ anchor_ref }>
        <Button
            $bare
            $icon
            aria-expanded={ open }
            aria-haspopup="menu"
            aria-label={ `Actions for ${ session.name }` }
            onClick={ () => open ? close() : set_open( true ) }
            ref={ trigger_ref }
            type="button"
        >
            <Ellipsis aria-hidden="true" strokeWidth={ 1.5 } />
        </Button>

        { open && <Menu aria-label={ `Actions for ${ session.name }` } ref={ menu_ref } role="menu">
            { items.map( item => {
                const Icon = item.icon
                const confirming = item.confirm && armed
                return <Item $danger={ confirming } key={ item.action } onClick={ () => choose( item ) } role="menuitem" type="button">
                    <Icon aria-hidden="true" strokeWidth={ 1.5 } />
                    <span>
                        { confirming ? `Restart anyway` : item.label }
                        { confirming && <small>It is { session.status || session.activity }; the current turn is cut off</small> }
                    </span>
                </Item>
            } ) }
            { !session.actions?.length && <Note>This session runs an older babysit. Restart it on the host for web actions.</Note> }
        </Menu> }
    </Anchor>
}
