import { useEffect, useRef, useState } from 'react'
import { Bot, Cpu, Folder, Inbox, Text } from 'lucide-react'
import { Link } from 'react-router-dom'
import styled, { keyframes } from 'styled-components'
import { Status } from '../atoms/Status.jsx'
import { Notice } from '../atoms/Notice.jsx'
import { Button } from '../atoms/Button.jsx'
import { PageHeading, Section, SectionHeading, Surface } from '../atoms/Layout.jsx'
import { Overview } from '../molecules/Overview.jsx'
import { SessionMenu } from '../molecules/SessionMenu.jsx'
import { api } from '../../modules/api.js'
import { age_label } from '../../modules/freshness.js'
import { use_poll } from '../../hooks/use_poll.js'
import { container_label } from '../../modules/usage.js'

const WIDE = `@media (min-width: 48rem)`

const COLUMNS = `minmax(0, 2.2fr) minmax(0, 1fr) minmax(0, 1fr) 13.5rem`
const TITLES_KEY = `babysit-show-titles`
const NOTICE_MS = 6_000

const Repositories = styled.div`
    display: grid;
    gap: 0.75rem;
    grid-template-columns: minmax(0, 1fr);
`

// Visible overflow lets a row's … menu float over the cards below; the banner
// and last row round their own corners instead of a clipping card
const List = styled( Surface ).attrs( { as: `section` } )`
    padding: 0;

    > h2 { border-radius: calc(0.75rem - 1px) calc(0.75rem - 1px) 0 0; }
    li:last-child { border-radius: 0 0 calc(0.75rem - 1px) calc(0.75rem - 1px); }
    li:only-child { border-radius: calc(0.75rem - 1px); }
    h2 + ul > li:only-child { border-radius: 0 0 calc(0.75rem - 1px) calc(0.75rem - 1px); }
`

// Repository banner, the web twin of a `babysit list` trunk
const Banner = styled.h2`
    align-items: center;
    background: var(--soft);
    color: var(--muted);
    display: flex;
    font-size: 0.8125rem;
    font-weight: 600;
    gap: 0.375rem;
    margin: 0;
    min-width: 0;
    padding: 0.375rem 0.75rem;

    svg { flex-shrink: 0; height: 0.875rem; width: 0.875rem; }
    span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    small { flex-shrink: 0; font-size: inherit; font-weight: 400; margin-left: auto; }

    ${ WIDE } { padding: 0.5rem 1rem; }
`

const Sessions = styled.ul`
    list-style: none;
    margin: 0;
    padding: 0;

    > li { border-top: 1px solid var(--line); }
`

// The row link fills the line; its … menu sits beside it, never inside the link
const Line = styled.li`
    align-items: center;
    display: flex;
    padding-right: 0.5rem;
    transition: background 160ms ease;

    &:hover { background: var(--hover); }

    ${ WIDE } { padding-right: 0.75rem; }
`

// Desktop column labels for the row grid below; rows carry their own text
const Columns = styled.div`
    display: none;

    ${ WIDE } {
        color: var(--muted);
        display: grid;
        font-size: 0.8125rem;
        gap: 1rem;
        grid-template-columns: ${ COLUMNS };
        padding: 0 3.75rem 0.5rem 1rem;
    }
`

// Phone: one tappable line, details live on the session page. Desktop: one table-like line.
const Row = styled( Link )`
    align-items: center;
    color: inherit;
    display: grid;
    flex: 1;
    gap: 0.5rem;
    grid-template-areas: 'name status';
    grid-template-columns: minmax(0, 1fr) auto;
    min-height: 2.75rem;
    min-width: 0;
    padding: 0.25rem 0.75rem;
    text-decoration: none;

    &:focus-visible { box-shadow: inset 0 0 0 3px var(--halo); outline: none; }

    ${ WIDE } {
        gap: 1rem;
        grid-template-areas: 'name agent resources status';
        grid-template-columns: ${ COLUMNS };
        padding: 0.625rem 1rem;
    }
`

const Name = styled.div`
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: 0 0.5rem;
    grid-area: name;
    min-width: 0;

    small { color: var(--muted); flex-basis: 100%; font-size: 0.8125rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    strong { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    span { color: var(--muted); flex-shrink: 0; font-size: 0.8125rem; }

    ${ WIDE } {
        strong { overflow: visible; overflow-wrap: anywhere; white-space: normal; }
        span { display: none; }
    }
`

// Desktop-only cells: phones show these on the session page
const Detail = styled.span`
    align-items: center;
    color: var(--muted);
    display: none;
    font-size: 0.875rem;
    gap: 0.375rem;
    min-width: 0;

    svg { flex-shrink: 0; height: 1rem; width: 1rem; }

    ${ WIDE } { display: inline-flex; }
`

const Agent = styled( Detail )`
    grid-area: agent;
`

const Resources = styled( Detail )`
    grid-area: resources;
`

const State = styled.div`
    align-items: flex-start;
    display: flex;
    grid-area: status;

    ${ WIDE } { flex-direction: column; gap: 0.25rem; }
`

// Unread: a finished turn nobody looked at yet, the blue dot of `babysit watch`
const Dot = styled.i`
    align-self: center;
    background: ${ ( { $on } ) => $on ? `var(--primary)` : `transparent` };
    border-radius: 999px;
    flex-shrink: 0;
    height: 0.5rem;
    width: 0.5rem;
`

const VISUALLY_HIDDEN = `clip-path: inset(50%); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px;`
const Hidden = styled.span`${ VISUALLY_HIDDEN }`

// Condensed idle row: dot, name, workspace and last opened on one line
const IdleRow = styled( Row )`
    grid-template-areas: 'name status';

    ${ WIDE } {
        grid-template-areas: 'name agent status';
        grid-template-columns: minmax(0, 2.2fr) minmax(0, 2fr) auto;
    }
`

const Toolbar = styled.div`
    align-items: flex-start;
    display: flex;
    gap: 0.5rem 1rem;
    justify-content: space-between;

    > header { margin-bottom: 0; }
`

const Stack = styled.div`
    display: grid;
    gap: 1rem;
    margin-top: 1.5rem;

    &:first-child { margin-top: 0; }
`

const Empty = styled( Surface )`
    align-items: center;
    display: grid;
    gap: 0.5rem;
    justify-items: center;
    padding: 2.5rem 1rem;
    text-align: center;

    svg { color: var(--muted); height: 1.5rem; width: 1.5rem; }
    p { margin: 0; }
    p + p { color: var(--muted); font-size: 0.9375rem; }
    code { background: var(--soft); border-radius: 0.25rem; padding: 0.1em 0.3em; }
`

const sweep = keyframes`
    from { background-position: 100% 0; }
    to { background-position: -100% 0; }
`

// Layout-shaped placeholder rows while the first poll lands
const Skeleton = styled.li`
    display: grid;
    gap: 0.5rem;
    padding: 1rem;

    span {
        animation: ${ sweep } 1800ms linear infinite;
        background: linear-gradient(90deg, var(--soft) 25%, var(--hover) 50%, var(--soft) 75%) 0 0 / 200% 100%;
        border-radius: 0.25rem;
        height: 0.875rem;
    }
    span:first-child { height: 1rem; width: 40%; }
    span:last-child { width: 70%; }
`

// Frozen and stuck outrank observed activity, as in `babysit watch`
const shown_status = ( session, offline ) => offline ? `unknown` : session.status || session.activity

// "opened 3h ago", from epoch seconds; never-opened sessions say so
const opened_label = last_opened => last_opened ? `opened ${ age_label( new Date( last_opened * 1_000 ).toISOString() ) }` : `never opened`

/** One session as a list row linking to its page, with its action menu. */
function SessionRow( { session, offline, show_titles, menu } ) {
    const seen = age_label( session.updated_at )

    return <Line>
        <Row to={ `/sessions/${ session.session_id }` }>
            <Name>
                <Dot $on={ session.unread } aria-hidden="true" />
                <strong>{ session.name }</strong>
                <span>{ session.agent }</span>
                { session.unread && <Hidden>, unread</Hidden> }
                { show_titles && session.title && <small>{ session.title }</small> }
            </Name>
            <Agent><Bot aria-hidden="true" strokeWidth={ 1.5 } />{ [ session.agent, ...session.modifiers ].join( ` · ` ) }</Agent>
            <Resources><Cpu aria-hidden="true" strokeWidth={ 1.5 } />{ container_label( session.container ) }</Resources>
            <State>
                <Status activity={ shown_status( session, offline ) } compact />
                <Detail>{ session.attachment } · { seen || `no heartbeat` }</Detail>
            </State>
        </Row>
        { menu( session ) }
    </Line>
}

/** An idle-list session: one condensed line, still openable and actionable. */
function IdleSessionRow( { session, offline, show_titles, menu } ) {
    return <Line>
        <IdleRow to={ `/sessions/${ session.session_id }` }>
            <Name>
                <Dot $on={ session.unread } aria-hidden="true" />
                <strong>{ session.name }</strong>
                <span>{ opened_label( session.last_opened ) }</span>
                { session.unread && <Hidden>, unread</Hidden> }
                { show_titles && session.title && <small>{ session.title }</small> }
            </Name>
            <Agent><Folder aria-hidden="true" strokeWidth={ 1.5 } />{ session.directory } · { opened_label( session.last_opened ) }</Agent>
            <State><Status activity={ shown_status( session, offline ) } compact /></State>
        </IdleRow>
        { menu( session ) }
    </Line>
}

/**
 * Group sessions per workspace. The server sends them newest-opened first, so
 * first-seen order ranks each workspace by its newest-opened session and keeps
 * that recency inside it, the way `babysit watch` orders its tree.
 */
const by_repository = sessions => {
    const groups = new Map()
    sessions.forEach( session => {
        const key = session.workspace || session.directory
        const { members = [] } = groups.get( key ) || {}
        groups.set( key, { key, directory: session.directory || `Directory unavailable`, members: [ ...members, session ] } )
    } )
    return [ ...groups.values() ]
}

// Watch's `i`: a view preference, kept per browser
const use_titles = () => {
    const [ show_titles, set_show_titles ] = useState( () => {
        try {
            return localStorage.getItem( TITLES_KEY ) === `1`
        } catch {
            return false
        }
    } )

    const toggle = () => set_show_titles( shown => {
        try {
            localStorage.setItem( TITLES_KEY, shown ? `0` : `1` )
        } catch {
            // Private mode: the toggle still works for this visit
        }
        return !shown
    } )

    return [ show_titles, toggle ]
}

/**
 * Active sessions newest-opened first, the idle list below (idle over a day or
 * moved there by hand), then host and account overview, from one status poll.
 */
export function SessionsPage( { role } ) {
    const { data, error, is_loading, reload } = use_poll( () => api( `/api/status` ) )
    const sessions = data?.sessions || []
    const active = sessions.filter( session => !session.parked )
    const idle = sessions.filter( session => session.parked )
    const [ show_titles, toggle_titles ] = use_titles()
    const [ notice, set_notice ] = useState( null )
    const notice_timer = useRef( null )

    useEffect( () => () => clearTimeout( notice_timer.current ), [] )

    // Action progress lingers briefly; failures stay until the next result
    const tell = ( text, { error: failed = false } = {} ) => {
        clearTimeout( notice_timer.current )
        set_notice( { text, error: failed } )
        if( !failed ) notice_timer.current = setTimeout( () => set_notice( null ), NOTICE_MS )
    }

    // Read-only keys see no menu: every entry but Open changes the host
    const menu = session => role === `write` && <SessionMenu refresh={ reload } report={ tell } session={ session } />
    const row_props = { menu, offline: Boolean( error ), show_titles }

    return <>
        <Toolbar>
            <PageHeading>
                <h1>Sessions</h1>
                <p>{ is_loading ? `Connecting…` : error ? `Connection interrupted — showing last received sessions` : `${ sessions.length } live ${ sessions.length === 1 ? `session` : `sessions` }` }</p>
            </PageHeading>
            { sessions.length > 0 && <Button $quiet aria-pressed={ show_titles } onClick={ toggle_titles } type="button">
                <Text aria-hidden="true" strokeWidth={ 1.5 } />{ show_titles ? `Hide task titles` : `Show task titles` }
            </Button> }
        </Toolbar>

        { ( error || notice ) && <Stack>
            { error && <Notice $error role="alert">{ error.message }. Reconnecting…</Notice> }
            { notice && <Notice $error={ notice.error } role={ notice.error ? `alert` : `status` }>{ notice.text }</Notice> }
        </Stack> }

        { is_loading && <List aria-busy="true" aria-label="Loading sessions">
            <Sessions>{ [ 0, 1, 2 ].map( index => <Skeleton key={ index }><span /><span /><span /></Skeleton> ) }</Sessions>
        </List> }

        { !is_loading && !error && sessions.length === 0 && <Empty>
            <Inbox aria-hidden="true" strokeWidth={ 1.5 } />
            <p>No live sessions.</p>
            <p>Start one on the host, for example <code>babysit claude</code>.</p>
        </Empty> }

        { active.length > 0 && <Stack>
            <Columns aria-hidden="true"><span>Session</span><span>Agent</span><span>Container</span><span>Status</span></Columns>
            <Repositories>
                { by_repository( active ).map( ( { key, directory, members } ) => <List aria-label={ directory } key={ key }>
                    <Banner><Folder aria-hidden="true" strokeWidth={ 1.5 } /><span>{ directory }</span><small>{ members.length }</small></Banner>
                    <Sessions>
                        { members.map( session => <SessionRow key={ session.session_id } session={ session } { ...row_props } /> ) }
                    </Sessions>
                </List> ) }
            </Repositories>
        </Stack> }

        { idle.length > 0 && <Section aria-labelledby="idle-heading">
            <SectionHeading>
                <h2 id="idle-heading">Idle</h2>
                <span>Idle over a day, or moved here; back on the next finished turn</span>
            </SectionHeading>
            <List aria-label="Idle sessions">
                <Sessions>
                    { idle.map( session => <IdleSessionRow key={ session.session_id } session={ session } { ...row_props } /> ) }
                </Sessions>
            </List>
        </Section> }

        { data && <Overview status={ data } /> }
    </>
}
