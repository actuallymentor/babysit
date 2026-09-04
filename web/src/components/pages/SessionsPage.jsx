import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { Status } from '../atoms/Status.jsx'
import { Notice } from '../atoms/Notice.jsx'
import { api } from '../../modules/api.js'
import { use_poll } from '../../hooks/use_poll.js'

const Heading = styled.div`
    margin-bottom: 1.5rem;
    h1 { font-size: clamp(1.7rem, 6vw, 2.7rem); margin: 0 0 0.35rem; }
    p { color: #5c6763; margin: 0; }
`

const Grid = styled.div`
    display: grid;
    gap: 0.8rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
`

const Card = styled( Link )`
    background: #ffffff;
    border: 1px solid #d8ddda;
    border-radius: 0.85rem;
    color: inherit;
    display: grid;
    gap: 0.85rem;
    min-height: 9rem;
    padding: 1rem;
    text-decoration: none;
    transition: border-color 150ms ease, transform 150ms ease;

    &:hover { border-color: #7b8c86; transform: translateY(-2px); }
    &:focus-visible { outline: 3px solid #7ec0d0; outline-offset: 2px; }
`

const CardHeader = styled.div`
    align-items: flex-start;
    display: flex;
    gap: 0.8rem;
    justify-content: space-between;

    h2 { font-size: 1.05rem; margin: 0; overflow-wrap: anywhere; }
`

const Metadata = styled.div`
    color: #5c6763;
    display: grid;
    font-size: 0.9rem;
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
            <p>Live Babysit sessions on this host.</p>
        </Heading>

        { error && <Notice $error role="alert">{ error.message }. Reconnecting…</Notice> }
        { is_loading && <Notice>Loading sessions…</Notice> }
        { !is_loading && !error && sessions.length === 0 && <Notice>No live sessions.</Notice> }

        <Grid>
            { sessions.map( session => <Card key={ session.session_id } to={ `/sessions/${ session.session_id }` }>
                <CardHeader>
                    <h2>{ session.name }</h2>
                    <Status activity={ session.activity } busy={ session.busy } />
                </CardHeader>
                <Metadata>
                    <span>{ session.agent } · { session.attachment }</span>
                    <span>{ session.directory || `Directory unavailable` }</span>
                    { session.modifiers.length > 0 && <span>{ session.modifiers.join( ` · ` ) }</span> }
                </Metadata>
            </Card> ) }
        </Grid>
    </>
}
