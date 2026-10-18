import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { api } from '../../modules/api.js'
import { heartbeat_label } from '../../modules/freshness.js'
import { ArrowDown, Bot, ChevronDown, ChevronLeft, Clock, Folder, Send, SquareTerminal } from 'lucide-react'
import { Section, SectionHeading, Surface } from '../atoms/Layout.jsx'
import { use_poll } from '../../hooks/use_poll.js'
import { Button } from '../atoms/Button.jsx'
import { MarkdownMessage } from '../molecules/MarkdownMessage.jsx'
import { Notice } from '../atoms/Notice.jsx'
import { Status } from '../atoms/Status.jsx'

const Back = styled( Link )`
    align-items: center;
    border-radius: 0.5rem;
    color: var(--primary);
    display: inline-flex;
    font-weight: 600;
    gap: 0.25rem;
    margin: -0.5rem 0 0.5rem -0.25rem;
    min-height: 2.75rem;
    padding: 0 0.25rem;
    text-decoration: none;

    svg { height: 1rem; width: 1rem; }
`

const Heading = styled.header`
    display: grid;
    gap: 0.5rem;

    > div:first-child { align-items: flex-start; display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; justify-content: space-between; }
    h1 { font-size: 1.625rem; line-height: 1.25; margin: 0; min-width: 0; overflow-wrap: anywhere; }
`

// Muted details, each with a fine icon in the same color
const Meta = styled.div`
    color: var(--muted);
    display: flex;
    flex-wrap: wrap;
    font-size: 0.875rem;
    gap: 0.25rem 1rem;

    span { align-items: center; display: inline-flex; gap: 0.375rem; min-width: 0; overflow-wrap: anywhere; }
    svg { flex-shrink: 0; height: 1rem; width: 1rem; }
`

const Panel = styled( Surface )`
    display: grid;
    gap: 1rem;
    grid-template-columns: minmax(0, 1fr);
    padding: clamp(1rem, 4vw, 1.5rem);
`

const Note = styled.p`
    color: var(--muted);
    font-size: 0.875rem;
    margin: 0;
`

const RawScreen = styled.pre`
    background: var(--code-bg);
    border-radius: 0.5rem;
    color: var(--code-text);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8125rem;
    line-height: 1.5;
    margin: 0.75rem 0 0;
    overflow: auto;
    padding: 1rem;
    white-space: pre;
    letter-spacing: normal;
    word-spacing: normal;
`

const Terminal = styled.details`
    > summary {
        align-items: center;
        border-radius: 0.5rem;
        color: var(--muted);
        cursor: pointer;
        display: flex;
        font-weight: 600;
        gap: 0.5rem;
        list-style: none;
        min-height: 2.75rem;
    }
    > summary::-webkit-details-marker { display: none; }
    > summary svg { height: 1rem; width: 1rem; }
    > summary svg:last-child { transform: rotate(-90deg); transition: transform 160ms ease; }
    &[open] > summary svg:last-child { transform: none; }
`

const Composer = styled.form`
    display: grid;
    gap: 0.75rem;

    textarea {
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        line-height: 1.5;
        min-height: 7rem;
        padding: 0.75rem;
        resize: vertical;
        transition: border-color 160ms ease, box-shadow 160ms ease;
        width: 100%;
    }
    textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 5px var(--halo); outline: 2px solid transparent; }
    textarea[aria-invalid='true'] { border-color: var(--danger); }
`

const ComposerFooter = styled.div`
    align-items: center;
    display: flex;
    gap: 0.75rem;
    justify-content: space-between;

    flex-wrap: wrap;
    small { color: var(--muted); font-size: 0.8125rem; }
`

const Pending = styled.ul`
    color: var(--muted);
    font-size: 0.875rem;
    list-style: none;
    margin: 0;
    padding: 0;

    li { border-top: 1px solid var(--line); padding: 0.625rem 0; overflow-wrap: anywhere; }
    strong { color: var(--text); font-weight: 600; }
    p { margin: 0.125rem 0 0; }
`

const ReplyJump = styled.div`
    bottom: 0;
    display: none;
    position: sticky;
    z-index: 2;

    @media (max-width: 40rem) {
        display: flex;
        justify-content: flex-end;
        padding: 0.75rem 0 max(0.75rem, env(safe-area-inset-bottom));
    }

    button { box-shadow: 0 4px 14px rgb(0 0 0 / 18%); }
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
        <Back to="/"><ChevronLeft aria-hidden="true" strokeWidth={ 1.5 } />Sessions</Back>
        <Notice $error role="alert">{ error?.message || `Session unavailable` }. It may have ended or missed its heartbeat.</Notice>
    </>

    return <>
        <Back to="/"><ChevronLeft aria-hidden="true" strokeWidth={ 1.5 } />Sessions</Back>
        <Heading>
            <div>
                <h1>{ session.name }</h1>
                <Status activity={ error ? `unknown` : session.activity } busy={ role === `write` && session.busy } />
            </div>
            <Meta>
                <span><Bot aria-hidden="true" strokeWidth={ 1.5 } />{ [ session.agent, ...session.modifiers ].join( ` · ` ) }</span>
                <span><Folder aria-hidden="true" strokeWidth={ 1.5 } />{ session.directory || `Directory unavailable` }</span>
                <span title={ session.updated_at || undefined }><Clock aria-hidden="true" strokeWidth={ 1.5 } />{ error ? `Connection interrupted` : `Connected` } · { heartbeat_label( session.updated_at ) }</span>
            </Meta>
        </Heading>
        { error && <Notice $error role="alert">{ error.message }. Showing the last received state; sending is paused until the connection recovers.</Notice> }

        <Section aria-label="Latest message">
            <SectionHeading><h2>Latest reply</h2></SectionHeading>
            <Panel>
                { session.last_message && !error && session.activity === `running` && <Note>Previous completed reply; agent is working.</Note> }
                { session.last_message && !error && session.activity === `waiting` && <Note>Previous completed reply; agent is waiting for background tasks.</Note> }
                { session.last_message
                    ? <MarkdownMessage>{ session.last_message }</MarkdownMessage>
                    : <Notice>No completed reply captured yet.</Notice> }
            </Panel>
        </Section>

        <Section id="reply" ref={ reply_ref }>
            <SectionHeading><h2>Reply</h2></SectionHeading>
            <Panel>
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
                        <Button disabled={ !can_send } type="submit"><Send aria-hidden="true" strokeWidth={ 1.5 } />{ is_sending ? `Sending…` : `Send` }</Button>
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
        </Section>

        { session.raw_screen && <Section>
            <Terminal>
                <summary><SquareTerminal aria-hidden="true" strokeWidth={ 1.5 } />Terminal output<ChevronDown aria-hidden="true" strokeWidth={ 1.5 } /></summary>
                <RawScreen aria-label="Terminal output" tabIndex="0">{ session.raw_screen }</RawScreen>
            </Terminal>
        </Section> }

        { role === `write` && !reply_visible && <ReplyJump>
            <Button onClick={ focus_reply } type="button"><ArrowDown aria-hidden="true" strokeWidth={ 1.5 } />Reply</Button>
        </ReplyJump> }
    </>
}
