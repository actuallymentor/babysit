import { Bot, ChevronRight, Cpu, Folder, Inbox } from 'lucide-react'
import { Link } from 'react-router-dom'
import styled, { keyframes } from 'styled-components'
import { Status } from '../atoms/Status.jsx'
import { Notice } from '../atoms/Notice.jsx'
import { PageHeading, Surface } from '../atoms/Layout.jsx'
import { Overview } from '../molecules/Overview.jsx'
import { api } from '../../modules/api.js'
import { age_label } from '../../modules/freshness.js'
import { use_poll } from '../../hooks/use_poll.js'
import { container_label } from '../../modules/usage.js'

const WIDE = `@media (min-width: 48rem)`

const COLUMNS = `minmax(0, 2.2fr) minmax(0, 1fr) minmax(0, 1fr) 13.5rem 1rem`

const Repositories = styled.div`
    display: grid;
    gap: 0.75rem;
    grid-template-columns: minmax(0, 1fr);
`

const List = styled( Surface ).attrs( { as: `section` } )`
    overflow: hidden;
    padding: 0;
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

// Desktop column labels for the row grid below; rows carry their own text
const Columns = styled.div`
    display: none;

    ${ WIDE } {
        color: var(--muted);
        display: grid;
        font-size: 0.8125rem;
        gap: 1rem;
        grid-template-columns: ${ COLUMNS };
        padding: 0 1rem 0.5rem;
    }
`

// Phone: one tappable line, details live on the session page. Desktop: one table-like line.
const Row = styled( Link )`
    align-items: center;
    color: inherit;
    display: grid;
    gap: 0.5rem;
    grid-template-areas: 'name status chevron';
    grid-template-columns: minmax(0, 1fr) auto 1rem;
    min-height: 2.75rem;
    padding: 0.25rem 0.75rem;
    text-decoration: none;
    transition: background 160ms ease;

    &:hover { background: var(--hover); }
    &:focus-visible { box-shadow: inset 0 0 0 3px var(--halo); }

    ${ WIDE } {
        gap: 1rem;
        grid-template-areas: 'name agent resources status chevron';
        grid-template-columns: ${ COLUMNS };
        padding: 0.625rem 1rem;
    }
`

const Name = styled.div`
    align-items: baseline;
    display: flex;
    gap: 0.5rem;
    grid-area: name;
    min-width: 0;

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

const Chevron = styled( ChevronRight )`
    align-self: center;
    color: var(--muted);
    grid-area: chevron;
    height: 1rem;
    width: 1rem;
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

/** One session as a list row linking to its page. */
function SessionRow( { session, offline } ) {
    const seen = age_label( session.updated_at )

    return <li>
        <Row to={ `/sessions/${ session.session_id }` }>
            <Name>
                <strong>{ session.name }</strong>
                <span>{ session.agent }</span>
            </Name>
            <Agent><Bot aria-hidden="true" strokeWidth={ 1.5 } />{ [ session.agent, ...session.modifiers ].join( ` · ` ) }</Agent>
            <Resources><Cpu aria-hidden="true" strokeWidth={ 1.5 } />{ container_label( session.container ) }</Resources>
            <State>
                <Status activity={ offline ? `unknown` : session.activity } compact />
                <Detail>{ session.attachment } · { seen || `no heartbeat` }</Detail>
            </State>
            <Chevron aria-hidden="true" strokeWidth={ 1.5 } />
        </Row>
    </li>
}

/**
 * Group sessions per workspace, alphabetically so banners hold still between
 * polls while activity reorders the rows inside them.
 */
const by_repository = sessions => {
    const groups = new Map()
    sessions.forEach( session => {
        const key = session.workspace || session.directory
        const { members = [] } = groups.get( key ) || {}
        groups.set( key, { key, directory: session.directory || `Directory unavailable`, members: [ ...members, session ] } )
    } )
    return [ ...groups.values() ].sort( ( first, second ) => first.directory.localeCompare( second.directory ) )
}

/** Active bridge sessions first, then host and account overview, from one status poll. */
export function SessionsPage() {
    const { data, error, is_loading } = use_poll( () => api( `/api/status` ) )
    const sessions = data?.sessions || []

    return <>
        <PageHeading>
            <h1>Sessions</h1>
            <p>{ is_loading ? `Connecting…` : error ? `Connection interrupted — showing last received sessions` : `${ sessions.length } live ${ sessions.length === 1 ? `session` : `sessions` }` }</p>
        </PageHeading>

        { error && <Notice $error role="alert">{ error.message }. Reconnecting…</Notice> }

        { is_loading && <List aria-busy="true" aria-label="Loading sessions">
            <Sessions>{ [ 0, 1, 2 ].map( index => <Skeleton key={ index }><span /><span /><span /></Skeleton> ) }</Sessions>
        </List> }

        { !is_loading && !error && sessions.length === 0 && <Empty>
            <Inbox aria-hidden="true" strokeWidth={ 1.5 } />
            <p>No live sessions.</p>
            <p>Start one on the host, for example <code>babysit claude</code>.</p>
        </Empty> }

        { sessions.length > 0 && <>
            <Columns aria-hidden="true"><span>Session</span><span>Agent</span><span>Container</span><span>Status</span></Columns>
            <Repositories>
                { by_repository( sessions ).map( ( { key, directory, members } ) => <List aria-label={ directory } key={ key }>
                    <Banner><Folder aria-hidden="true" strokeWidth={ 1.5 } /><span>{ directory }</span><small>{ members.length }</small></Banner>
                    <Sessions>
                        { members.map( session => <SessionRow key={ session.session_id } offline={ Boolean( error ) } session={ session } /> ) }
                    </Sessions>
                </List> ) }
            </Repositories>
        </> }

        { data && <Overview status={ data } /> }
    </>
}
