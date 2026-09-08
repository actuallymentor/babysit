import { useRef, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import styled from 'styled-components'

const Message = styled.article`
    color: var(--text);
    font-size: inherit;
    max-width: 65ch;
    width: 100%;
    line-height: 1.65;
    overflow-wrap: anywhere;

    > :first-child { margin-top: 0; }
    > :last-child { margin-bottom: 0; }

    h1, h2, h3, h4 {
        font-family: 'Montserrat Variable', system-ui, sans-serif;
        font-weight: 500;
        line-height: 1.3;
        margin: 1.6em 0 0.6em;
    }

    h1 { font-size: 1.55rem; }
    h2 { font-size: 1.3rem; }
    h3, h4 { font-size: 1.1rem; }

    p, ul, ol, pre, blockquote, table { margin: 0 0 1.15rem; }
    ul, ol { padding-left: 1.5rem; }
    li + li { margin-top: 0.35rem; }

    code {
        background: var(--soft);
        border-radius: 0.2rem;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.88em;
        padding: 0.12em 0.28em;
        letter-spacing: normal;
        word-spacing: normal;
    }

    pre {
        background: var(--code-bg);
        border-radius: 0.25rem;
        color: var(--code-text);
        max-width: 100%;
        overflow: auto;
        padding: 1rem;
        white-space: pre;
        letter-spacing: normal;
        word-spacing: normal;
    }

    pre code { background: none; padding: 0; }

    blockquote {
        border-left: 0.25rem solid var(--accent);
        color: var(--muted);
        padding-left: 1rem;
    }

    table { border-collapse: collapse; display: block; overflow-x: auto; }
    th, td { border: 1px solid var(--border); padding: 0.55rem; text-align: left; }
    a { color: var(--primary); font-weight: 700; }
`

const CodeBlock = styled.div`
    background: var(--code-bg);
    border-radius: 0.25rem;
    margin-bottom: 1.15rem;
    overflow: hidden;

    > div {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        justify-content: flex-end;
        padding: 0.25rem 0.5rem;
    }
    button {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 0.2rem;
        color: var(--text);
        cursor: pointer;
        font: inherit;
        font-size: 0.85em;
        min-height: 2.75rem;
        padding: 0.25em 0.75em;
    }
    span { color: var(--code-text); font-size: 0.85em; }
    pre { margin: 0; }
`

// Read rendered code text so fenced language labels never enter the clipboard.
const CopyableCode = ( { children } ) => {
    const code_ref = useRef( null )
    const [ feedback, set_feedback ] = useState( `` )

    const copy_code = async () => {
        try {
            await navigator.clipboard.writeText( code_ref.current.textContent )
            set_feedback( `Copied` )
        } catch {
            set_feedback( `Copy failed. Select the code to copy it.` )
        }
    }

    return <CodeBlock>
        <div>
            <span role="status">{ feedback }</span>
            <button aria-label="Copy code" onClick={ copy_code } type="button">Copy</button>
        </div>
        <pre aria-label="Code block" ref={ code_ref } tabIndex="0">{ children }</pre>
    </CodeBlock>
}

const safe_link = ( { children, href, title } ) => {
    const allowed_href = defaultUrlTransform( href || `` )
    if( !allowed_href ) return <span>{ children }</span>
    return <a href={ allowed_href } rel="noreferrer" target="_blank" title={ title }>{ children }</a>
}

/** Renders a deliberately restricted Markdown subset without raw HTML or images. */
export function MarkdownMessage( { children } ) {
    return <Message data-testid="markdown-message">
        <ReactMarkdown
            components={ { a: safe_link, img: () => null, pre: CopyableCode } }
            remarkPlugins={ [ remarkGfm, remarkBreaks ] }
            skipHtml
        >
            { children }
        </ReactMarkdown>
    </Message>
}
