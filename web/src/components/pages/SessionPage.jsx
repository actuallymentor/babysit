import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { api } from '../../modules/api.js'
import { heartbeat_label } from '../../modules/freshness.js'
import { use_poll } from '../../hooks/use_poll.js'
import { Button } from '../atoms/Button.jsx'
import { MarkdownMessage } from '../molecules/MarkdownMessage.jsx'
import { Notice } from '../atoms/Notice.jsx'
import { Status } from '../atoms/Status.jsx'

const Back = styled( Link )`
    color: var(--primary);
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
    flex-wrap: wrap;
    margin-bottom: 0.5rem;

    > div { min-width: 0; }
    h1 { font-size: clamp(1.45rem, 6vw, 2.35rem); margin: 0 0 0.3rem; overflow-wrap: anywhere; }
    p { color: var(--muted); margin: 0; overflow-wrap: anywhere; }
`

const Panel = styled.section`
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.25rem;
    margin-bottom: 1rem;
    padding: clamp(1rem, 4vw, 1.5rem);

    > h2 {
        color: var(--muted);
        font-size: 0.8rem;
        letter-spacing: normal;
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
    white-space: pre;
    letter-spacing: normal;
    word-spacing: normal;
`

const Terminal = styled( Panel )`
    > summary {
        color: var(--muted);
        cursor: pointer;
        font-weight: 700;
        min-height: 2.75rem;
    }
`

const Composer = styled.form`
    display: grid;
    gap: 0.65rem;

    textarea {
        border: 1px solid var(--border);
        border-radius: 0.25rem;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        line-height: 1.5;
        min-height: 7rem;
        padding: 0.8rem;
        resize: vertical;
        width: 100%;
    }
    textarea:focus { border-color: var(--primary); outline: 3px solid var(--primary); }
`

const ComposerFooter = styled.div`
    align-items: center;
    display: flex;
    gap: 0.75rem;
    justify-content: space-between;

    flex-wrap: wrap;
    small { color: var(--muted); }
`

const Pending = styled.ul`
    color: var(--muted);
    font-size: 0.9rem;
    list-style: none;
    margin: 0.75rem 0 0;
    padding: 0;

    li { border-top: 1px solid var(--border); padding: 0.65rem 0; overflow-wrap: anywhere; }
    p { margin: 0.2rem 0 0; }
`

const Freshness = styled.p`
    color: var(--muted);
    font-size: 0.85em;
    margin: 0 0 1.5rem;
`

const ReplyJump = styled.div`
    bottom: 0;
    display: none;
    position: sticky;
    z-index: 2;

    @media (max-width: 40rem) {
        background: var(--surface);
        border-top: 1px solid var(--border);
        display: flex;
        justify-content: flex-end;
        padding: 0.5rem 0 max(0.5rem, env(safe-area-inset-bottom));
    }
`

const send_status = {
    pending: `Queued`,
    claimed: `Delivering`,
    accepted: `Delivered to agent`,
    rejected: `Rejected`,
    failed: `Failed`,
    timed_out: `Timed out`,
}

/** Shows one live session and sends constrained text requests. */
export function SessionPage( { role } ) {
    const { session_id } = useParams()
    const { data, error, is_loading, reload } = use_poll( () => api( `/api/sessions/${ session_id }` ), [ session_id ] )
    const [ message, set_message ] = useState( `` )
    const [ send_error, set_send_error ] = useState( null )
    const [ is_sending, set_is_sending ] = useState( false )
    const [ previews, set_previews ] = useState( {} )
    const editor_ref = useRef( null )
    const reply_ref = useRef( null )
    const [ reply_visible, set_reply_visible ] = useState( false )
    const session = data?.session?.session_id === session_id ? data.session : null
    const byte_count = new TextEncoder().encode( message ).length
    const has_unsupported_characters = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test( message )
    const can_send = role === `write` && session && !error && !session.busy && message.trim().length > 0 && byte_count <= 16_384 && !has_unsupported_characters && !is_sending

    // Keep the shortcut out of the way once the actual reply controls are visible.
    useEffect( () => {
        if( !reply_ref.current ) return
        const observer = new IntersectionObserver( ( [ entry ] ) => set_reply_visible( entry.isIntersecting ) )
        observer.observe( reply_ref.current )
        return () => observer.disconnect()
    }, [ session?.session_id, error?.status_code ] )

    const send_message = async event => {
        event.preventDefault()
        if( !can_send ) return
        set_send_error( null )
        set_is_sending( true )

        try {
            const result = await api( `/api/sessions/${ session_id }/messages`, {
                body: JSON.stringify( { text: message } ),
                method: `POST`,
            } )
            // Keep only short, in-memory previews; drafts and sent text never enter storage.
            const preview = message.replace( /\s+/g, ` ` ).trim().slice( 0, 100 )
            set_previews( previous => ( { ...Object.fromEntries( Object.entries( previous ).slice( -19 ) ), [ result.request_id ]: preview } ) )
            set_message( `` )
            await reload()
        } catch ( request_error ) {
            set_send_error( request_error.message )
        } finally {
            set_is_sending( false )
        }
    }

    const focus_reply = () => {
        editor_ref.current?.scrollIntoView( { block: `center` } )
        editor_ref.current?.focus( { preventScroll: true } )
    }

    if( is_loading || data && !session && !error ) return <Notice>Loading session…</Notice>
    if( !session || error?.status_code === 404 ) return <>
        <Back to="/">← Sessions</Back>
        <Notice $error role="alert">{ error?.message || `Session unavailable` }. It may have ended or missed its heartbeat.</Notice>
    </>

    return <>
        <Back to="/">← Sessions</Back>
        <Heading>
            <div>
                <h1>{ session.name }</h1>
                <p>{ session.agent } · { session.directory || `Directory unavailable` }</p>
            </div>
            <Status activity={ error ? `unknown` : session.activity } busy={ role === `write` && session.busy } />
        </Heading>
        <Freshness title={ session.updated_at || undefined }>{ error ? `Connection interrupted` : `Connected` } · { heartbeat_label( session.updated_at ) }</Freshness>
        { error && <Notice $error role="alert">{ error.message }. Showing the last received state; sending is paused until the connection recovers.</Notice> }

        <Panel aria-label="Latest message">
            <h2>Latest completed reply</h2>
            { session.last_message && !error && session.activity === `running` && <Freshness>Previous completed reply; agent is working.</Freshness> }
            { session.last_message
                ? <MarkdownMessage>{ session.last_message }</MarkdownMessage>
                : <Notice>No completed reply captured yet.</Notice> }
        </Panel>

        <Panel id="reply" ref={ reply_ref }>
            <h2>Reply</h2>
            { role === `read` && <Notice>This access key is read-only.</Notice> }
            { session.busy && <Notice>Babysit is handling another action.{ role === `write` && ` You can draft while sending is paused.` }</Notice> }
            { send_error && <Notice $error role="alert">{ send_error }</Notice> }

            { role === `write` && <Composer onSubmit={ send_message }>
                <textarea
                    aria-describedby="message-help"
                    aria-invalid={ has_unsupported_characters || byte_count > 16_384 }
                    aria-label="Message"
                    disabled={ is_sending }
                    onChange={ event => set_message( event.target.value ) }
                    placeholder="Type a message for this session…"
                    ref={ editor_ref }
                    value={ message }
                />
                <ComposerFooter>
                    <small id="message-help" role="status">{ has_unsupported_characters ? `Unsupported control characters` : byte_count >= 14_746 ? `${ byte_count.toLocaleString() } / 16,384 bytes${ byte_count > 16_384 ? ` — message too long` : `` }` : `` }</small>
                    <Button disabled={ !can_send } type="submit">{ is_sending ? `Sending…` : `Send` }</Button>
                </ComposerFooter>
            </Composer> }

            { data.pending.length > 0 && <Pending aria-label="Recent sends" aria-live="polite">
                { data.pending.map( pending => <li key={ pending.request_id }>
                    <strong>{ send_status[ pending.status ] || `Delivery unknown` }</strong>
                    <p>{ previews[ pending.request_id ] || `Message ${ pending.request_id.slice( 0, 8 ) }` }</p>
                    { pending.message && <p>{ pending.message }</p> }
                </li> ) }
            </Pending> }
        </Panel>

        { session.raw_screen && <Terminal as="details">
            <summary>Terminal output</summary>
            <RawScreen aria-label="Terminal output" tabIndex="0">{ session.raw_screen }</RawScreen>
        </Terminal> }

        { role === `write` && !reply_visible && <ReplyJump>
            <Button onClick={ focus_reply } type="button">Reply ↓</Button>
        </ReplyJump> }
    </>
}
