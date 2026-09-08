import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { Heartbeat } from '../atoms/Heartbeat.jsx'
import { Status } from '../atoms/Status.jsx'
import { Notice } from '../atoms/Notice.jsx'
import { api } from '../../modules/api.js'
import { use_poll } from '../../hooks/use_poll.js'

const Heading = styled.div`
    margin-bottom: 1.5rem;
    h1 { font-size: clamp(1.7rem, 6vw, 2.7rem); margin: 0 0 0.35rem; }
    p { color: var(--muted); margin: 0; }
`

const Grid = styled.div`
    display: grid;
    gap: 0.8rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
`

const Card = styled( Link )`
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.35rem;
    color: inherit;
    display: grid;
    gap: 0.75rem;
    padding: 1rem;
    text-decoration: none;
    transition: background 150ms ease;

    &:hover { background: var(--soft); }
    &:focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }
`

const CardHeader = styled.div`
    align-items: flex-start;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    justify-content: space-between;

    h2 { font-size: 1.05em; margin: 0; overflow-wrap: anywhere; }
`

const Metadata = styled.div`
    color: var(--muted);
    display: grid;
    font-size: 0.9em;
    gap: 0.3rem;

    span { overflow-wrap: anywhere; }
`

/** Lists only active bridge sessions. */
export function SessionsPage() {
    const { data, error, is_loading } = use_poll( () => api( `/api/sessions` ) )
    const sessions = data?.sessions || []

    return <>
        <Heading>
            <h1>Sessions</h1>
            <p>{ is_loading ? `Connecting…` : error ? `Connection interrupted — showing last received sessions` : `${ sessions.length } live ${ sessions.length === 1 ? `session` : `sessions` }` }</p>
        </Heading>

        { error && <Notice $error role="alert">{ error.message }. Reconnecting…</Notice> }
        { is_loading && <Notice>Loading sessions…</Notice> }
        { !is_loading && !error && sessions.length === 0 && <Notice>No live sessions.</Notice> }

        <Grid>
            { sessions.map( session => <Card key={ session.session_id } to={ `/sessions/${ session.session_id }` }>
                <CardHeader>
                    <h2>{ session.name }</h2>
                    <Status activity={ error ? `unknown` : session.activity } busy={ session.busy } />
                </CardHeader>
                <Metadata>
                    <span>{ [ session.agent, ...session.modifiers ].join( ` · ` ) }</span>
                    <span>{ session.directory || `Directory unavailable` }</span>
                    <span>{ session.attachment } · <Heartbeat updated_at={ session.updated_at } /></span>
                </Metadata>
            </Card> ) }
        </Grid>
    </>
}
