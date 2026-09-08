import '@fontsource-variable/montserrat'
import '@fontsource-variable/nunito'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createGlobalStyle } from 'styled-components'
import { App } from './App.jsx'

const dark_colors = `
    color-scheme: dark;
    --background: #141c24;
    --surface: #1d2833;
    --text: #edf3f7;
    --muted: #b0c1ce;
    --border: #617687;
    --accent: #7ec0d0;
    --primary: #7ec0d0;
    --on-primary: #14232b;
    --soft: #293e4c;
    --danger: #ffb8ac;
    --danger-bg: #492b2b;
    --code-bg: #101820;
    --code-text: #edf3f7;
`

const GlobalStyle = createGlobalStyle`
    *, *::before, *::after { box-sizing: border-box; }

    html {
        color-scheme: light;
        --background: #fafbfc;
        --surface: #ffffff;
        --text: #20303d;
        --muted: #536777;
        --border: #7d909d;
        --accent: #7ec0d0;
        --primary: #286477;
        --on-primary: #ffffff;
        --soft: #e5f1f5;
        --danger: #922e24;
        --danger-bg: #fcebe7;
        --code-bg: #182733;
        --code-text: #edf3f7;
        background: var(--background);
        color: var(--text);
        font-size: 100%;
        scroll-padding-top: 6rem;
    }

    html[data-theme='dark'] { ${ dark_colors } }
    @media (prefers-color-scheme: dark) {
        html:not([data-theme='light']) { ${ dark_colors } }
    }

    body {
        font-family: 'Nunito Variable', system-ui, -apple-system, 'Segoe UI', sans-serif;
        font-size: clamp(1rem, 0.94rem + 0.3vw, 1.125rem);
        line-height: 1.5;
        margin: 0;
        overflow-wrap: anywhere;
    }

    button, input, textarea, select { font: inherit; }
    input, textarea, select { background: var(--surface); color: var(--text); }
    h1, h2, h3 { font-family: 'Montserrat Variable', system-ui, sans-serif; font-weight: 500; }
    a { color: var(--primary); }
    :focus-visible { outline: 3px solid var(--primary); outline-offset: 3px; }
    button, a, summary, select { -webkit-tap-highlight-color: transparent; }

    @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
    }
`

createRoot( document.getElementById( `root` ) ).render(
    <StrictMode>
        <GlobalStyle />
        <App />
    </StrictMode>,
)
