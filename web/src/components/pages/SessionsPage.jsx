import { Bot, ChevronRight, Clock, Cpu, Folder, Inbox } from 'lucide-react'
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

const List = styled( Surface ).attrs( { as: `ul` } )`
    list-style: none;
    margin: 0;
    overflow: hidden;
    padding: 0;

    > li + li { border-top: 1px solid var(--line); }
`

// Desktop column labels for the row grid below; rows carry their own text
const Columns = styled.div`
    display: none;

    ${ WIDE } {
        color: var(--muted);
        display: grid;
        font-size: 0.8125rem;
        gap: 1rem;
        grid-template-columns: minmax(0, 2.2fr) minmax(0, 1fr) minmax(0, 1fr) 10rem 1rem;
        padding: 0 1rem 0.5rem;
    }
`

// Phone: name + status, then details. Desktop: one table-like line per session.
const Row = styled( Link )`
    color: inherit;
    display: grid;
    gap: 0.375rem 0.75rem;
    grid-template-areas: 'name chevron' 'status chevron' 'details chevron';
    grid-template-columns: minmax(0, 1fr) 1rem;
    padding: 0.875rem 1rem;
    text-decoration: none;
    transition: background 160ms ease;

    &:hover { background: var(--hover); }
    &:focus-visible { box-shadow: inset 0 0 0 3px var(--halo); }

    ${ WIDE } {
        align-items: center;
        gap: 1rem;
        grid-template-areas: 'name agent resources status chevron';
        grid-template-columns: minmax(0, 2.2fr) minmax(0, 1fr) minmax(0, 1fr) 10rem 1rem;
    }
`

const Name = styled.div`
    display: grid;
    gap: 0.125rem;
    grid-area: name;
    min-width: 0;

    strong { font-weight: 600; overflow-wrap: anywhere; }
`

// Detail lines: muted, each with a fine icon in the same color
const Detail = styled.span`
    align-items: center;
    color: var(--muted);
    display: inline-flex;
    font-size: 0.875rem;
    gap: 0.375rem;
    min-width: 0;

    svg { flex-shrink: 0; height: 1rem; width: 1rem; }
`

const Details = styled.div`
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    grid-area: details;

    ${ WIDE } { display: contents; }
`

const Agent = styled( Detail )`
    ${ WIDE } { grid-area: agent; }
`

const Resources = styled( Detail )`
    ${ WIDE } { grid-area: resources; }
`

const State = styled.div`
    align-items: flex-start;
    display: flex;
    grid-area: status;

    ${ WIDE } { align-items: flex-start; flex-direction: column; gap: 0.25rem; }
`

const Chevron = styled( ChevronRight )`
    align-self: center;
    color: var(--muted);
    grid-area: chevron;
    height: 1rem;
    width: 1rem;
`

// Desktop-only detail: phones show these inside the details line instead
const WideDetail = styled( Detail )`
    display: none;
    ${ WIDE } { display: inline-flex; }
`

const PhoneOnly = styled.span`
    display: contents;
    ${ WIDE } { display: none; }
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
function SessionRow( { session, role, offline } ) {
    const seen = age_label( session.updated_at )

    return <li>
        <Row to={ `/sessions/${ session.session_id }` }>
            <Name>
                <strong>{ session.name }</strong>
                <WideDetail><Folder aria-hidden="true" strokeWidth={ 1.5 } />{ session.directory || `Directory unavailable` }</WideDetail>
            </Name>
            <Details>
                <Agent><Bot aria-hidden="true" strokeWidth={ 1.5 } />{ [ session.agent, ...session.modifiers ].join( ` · ` ) }</Agent>
                <PhoneOnly><Detail><Folder aria-hidden="true" strokeWidth={ 1.5 } />{ session.directory || `Directory unavailable` }</Detail></PhoneOnly>
                <Resources><Cpu aria-hidden="true" strokeWidth={ 1.5 } />{ container_label( session.container ) }</Resources>
                <PhoneOnly>{ seen && <Detail title={ `${ session.attachment } · last heartbeat ${ seen }` }><Clock aria-hidden="true" strokeWidth={ 1.5 } />{ seen }</Detail> }</PhoneOnly>
            </Details>
            <State>
                <Status activity={ offline ? `unknown` : session.activity } busy={ role === `write` && session.busy } />
                <WideDetail>{ session.attachment } · { seen || `no heartbeat` }</WideDetail>
            </State>
            <Chevron aria-hidden="true" strokeWidth={ 1.5 } />
        </Row>
    </li>
}

/** Active bridge sessions first, then host and account overview, from one status poll. */
export function SessionsPage( { role } ) {
    const { data, error, is_loading } = use_poll( () => api( `/api/status` ) )
    const sessions = data?.sessions || []

    return <>
        <PageHeading>
            <h1>Sessions</h1>
            <p>{ is_loading ? `Connecting…` : error ? `Connection interrupted — showing last received sessions` : `${ sessions.length } live ${ sessions.length === 1 ? `session` : `sessions` }` }</p>
        </PageHeading>

        { error && <Notice $error role="alert">{ error.message }. Reconnecting…</Notice> }

        { is_loading && <List aria-busy="true" aria-label="Loading sessions">
            { [ 0, 1, 2 ].map( index => <Skeleton key={ index }><span /><span /><span /></Skeleton> ) }
        </List> }

        { !is_loading && !error && sessions.length === 0 && <Empty>
            <Inbox aria-hidden="true" strokeWidth={ 1.5 } />
            <p>No live sessions.</p>
            <p>Start one on the host, for example <code>babysit claude</code>.</p>
        </Empty> }

        { sessions.length > 0 && <>
            <Columns aria-hidden="true"><span>Session</span><span>Agent</span><span>Container</span><span>Status</span></Columns>
            <List>
                { sessions.map( session => <SessionRow key={ session.session_id } offline={ Boolean( error ) } role={ role } session={ session } /> ) }
            </List>
        </> }

        { data && <Overview status={ data } /> }
    </>
}
