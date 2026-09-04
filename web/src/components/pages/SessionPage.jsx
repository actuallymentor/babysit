import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { api } from '../../modules/api.js'
import { use_poll } from '../../hooks/use_poll.js'
import { Button } from '../atoms/Button.jsx'
import { MarkdownMessage } from '../molecules/MarkdownMessage.jsx'
import { Notice } from '../atoms/Notice.jsx'
import { Status } from '../atoms/Status.jsx'

const Back = styled( Link )`
    color: #3c5650;
    display: inline-flex;
    font-weight: 700;
    margin-bottom: 1rem;
    min-height: 2.75rem;
    text-decoration: none;
`

const Heading = styled.div`
    align-items: flex-start;
    display: flex;
    gap: 1rem;
    justify-content: space-between;
    margin-bottom: 1.5rem;

    h1 { font-size: clamp(1.45rem, 6vw, 2.35rem); margin: 0 0 0.3rem; overflow-wrap: anywhere; }
    p { color: #5c6763; margin: 0; overflow-wrap: anywhere; }
`

const Panel = styled.section`
    background: #ffffff;
    border: 1px solid #d8ddda;
    border-radius: 0.85rem;
    margin-bottom: 1rem;
    padding: clamp(1rem, 4vw, 1.5rem);

    > h2 {
        color: #59645f;
        font-size: 0.8rem;
        letter-spacing: 0.12em;
        margin: 0 0 1.2rem;
        text-transform: uppercase;
    }
`

const RawScreen = styled.pre`
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85rem;
    line-height: 1.5;
    margin: 0;
    overflow: auto;
    white-space: pre-wrap;
`

const Composer = styled.form`
    display: grid;
    gap: 0.65rem;

    textarea {
        border: 1px solid #99a49f;
        border-radius: 0.65rem;
        font: inherit;
        line-height: 1.5;
        min-height: 7rem;
        padding: 0.8rem;
        resize: vertical;
        width: 100%;
    }
    textarea:focus { border-color: #356b77; outline: 3px solid #d5ecf1; }
`

const ComposerFooter = styled.div`
    align-items: center;
    display: flex;
    gap: 0.75rem;
    justify-content: space-between;

    small { color: #68716e; }
`

const Pending = styled.ul`
    color: #53605c;
    font-size: 0.9rem;
    list-style: none;
    margin: 0.75rem 0 0;
    padding: 0;
`

/** Shows one live session and sends constrained text requests. */
export function SessionPage( { role } ) {
    const { session_id } = useParams()
    const { data, error, is_loading, reload } = use_poll( () => api( `/api/sessions/${ session_id }` ), [ session_id ] )
    const [ message, set_message ] = useState( `` )
    const [ send_error, set_send_error ] = useState( null )
    const [ is_sending, set_is_sending ] = useState( false )
    const session = data?.session
    const byte_count = new TextEncoder().encode( message ).length

    const send_message = async event => {
        event.preventDefault()
        set_send_error( null )
        set_is_sending( true )

        try {
            await api( `/api/sessions/${ session_id }/messages`, {
                body: JSON.stringify( { text: message } ),
                method: `POST`,
            } )
            set_message( `` )
            if( navigator.vibrate ) navigator.vibrate( 35 )
            await reload()
        } catch ( request_error ) {
            set_send_error( request_error.message )
        } finally {
            set_is_sending( false )
        }
    }

    if( is_loading ) return <Notice>Loading session…</Notice>
    if( error || !session ) return <>
        <Back to="/">← Sessions</Back>
        <Notice $error role="alert">{ error?.message || `Session unavailable` }. It may have ended or missed its heartbeat.</Notice>
    </>

    const has_unsupported_characters = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test( message )
    const can_send = role === `write` && !session.busy && message.trim().length > 0 && byte_count <= 16_384 && !has_unsupported_characters && !is_sending

    return <>
        <Back to="/">← Sessions</Back>
        <Heading>
            <div>
                <h1>{ session.name }</h1>
                <p>{ session.agent } · { session.directory || `Directory unavailable` }</p>
            </div>
            <Status activity={ session.activity } busy={ session.busy } />
        </Heading>

        <Panel>
            <h2>Latest message</h2>
            { session.last_message
                ? <MarkdownMessage>{ session.last_message }</MarkdownMessage>
                : session.raw_screen
                    ? <RawScreen>{ session.raw_screen }</RawScreen>
                    : <Notice>No stable message captured yet.</Notice> }
        </Panel>

        <Panel>
            <h2>Reply</h2>
            { role === `read` && <Notice>This access key is read-only.</Notice> }
            { session.busy && <Notice>Babysit is handling another action. Sending will unlock when it finishes.</Notice> }
            { send_error && <Notice $error role="alert">{ send_error }</Notice> }

            { role === `write` && <Composer onSubmit={ send_message }>
                <textarea
                    aria-label="Message"
                    disabled={ session.busy || is_sending }
                    onChange={ event => set_message( event.target.value ) }
                    placeholder="Type a message for this session…"
                    value={ message }
                />
                <ComposerFooter>
                    <small>{ has_unsupported_characters ? `Unsupported control characters` : `${ byte_count.toLocaleString() } / 16,384 bytes` }</small>
                    <Button disabled={ !can_send } type="submit">{ is_sending ? `Sending…` : `Send` }</Button>
                </ComposerFooter>
            </Composer> }

            { data.pending.length > 0 && <Pending aria-label="Recent sends">
                { data.pending.map( pending => <li key={ pending.request_id }>Message: { pending.status.replace( `_`, ` ` ) }</li> ) }
            </Pending> }
        </Panel>
    </>
}
