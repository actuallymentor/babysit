import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import styled from 'styled-components'

const Message = styled.article`
    color: #202825;
    font-size: 1rem;
    line-height: 1.65;
    overflow-wrap: anywhere;

    > :first-child { margin-top: 0; }
    > :last-child { margin-bottom: 0; }

    h1, h2, h3, h4 {
        font-family: 'Montserrat Variable', system-ui, sans-serif;
        font-weight: 600;
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
        background: #e9ece8;
        border-radius: 0.3rem;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.88em;
        padding: 0.12em 0.28em;
    }

    pre {
        background: #16211f;
        border-radius: 0.65rem;
        color: #edf4f1;
        max-width: 100%;
        overflow: auto;
        padding: 1rem;
        white-space: pre-wrap;
    }

    pre code { background: none; padding: 0; }

    blockquote {
        border-left: 0.25rem solid #7ec0d0;
        color: #4d5955;
        padding-left: 1rem;
    }

    table { border-collapse: collapse; display: block; overflow-x: auto; }
    th, td { border: 1px solid #c8cecb; padding: 0.55rem; text-align: left; }
    a { color: #285d69; font-weight: 700; }
`

const safe_link = ( { children, href, ...properties } ) => {
    const allowed_href = defaultUrlTransform( href || `` )
    if( !allowed_href ) return <span>{ children }</span>
    return <a { ...properties } href={ allowed_href } rel="noreferrer" target="_blank">{ children }</a>
}

/** Renders a deliberately restricted Markdown subset without raw HTML or images. */
export function MarkdownMessage( { children } ) {
    return <Message data-testid="markdown-message">
        <ReactMarkdown
            components={ { a: safe_link, img: () => null } }
            remarkPlugins={ [ remarkGfm, remarkBreaks ] }
            skipHtml
        >
            { children }
        </ReactMarkdown>
    </Message>
}
