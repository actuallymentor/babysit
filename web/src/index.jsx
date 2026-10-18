import '@fontsource-variable/montserrat'
import '@fontsource-variable/nunito'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createGlobalStyle } from 'styled-components'
import { App } from './App.jsx'

// Solarized-style deep blue; the brand accent doubles as primary on dark
const dark_colors = `
    color-scheme: dark;
    --background: #002b36;
    --surface: #073642;
    --text: #e6ecf0;
    --muted: #aab6c1;
    --line: #134b58;
    --border: #5b8591;
    --hover: #0b3f4c;
    --accent: #7ec0d0;
    --primary: #7ec0d0;
    --on-primary: #002b36;
    --soft: #0e4553;
    --halo: rgb(126 192 208 / 25%);
    --danger: #ffb8ac;
    --danger-bg: #3d2a2c;
    --warning: #f0c040;
    --warning-text: #f0c040;
    --critical: #e07c5a;
    --code-bg: #00212a;
    --code-text: #e6ecf0;
`

const GlobalStyle = createGlobalStyle`
    *, *::before, *::after { box-sizing: border-box; }

    html {
        color-scheme: light;
        --background: #fafbfc;
        --surface: #ffffff;
        --text: #1a1a2e;
        --muted: #5f6672;
        --line: #e6e9ed;
        --border: #8a949e;
        --hover: #f2f7f9;
        --accent: #7ec0d0;
        --primary: #376675;
        --on-primary: #ffffff;
        --soft: #eaf4f7;
        --halo: rgb(126 192 208 / 27%);
        --danger: #922e24;
        --danger-bg: #fcebe7;
        --warning: #c7951a;
        --warning-text: #7a5600;
        --critical: #d0603c;
        --code-bg: #0b2530;
        --code-text: #e6ecf0;
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
        background: var(--background);
        font-family: 'Nunito Variable', system-ui, -apple-system, 'Segoe UI', sans-serif;
        font-size: clamp(1rem, 0.94rem + 0.3vw, 1.0625rem);
        line-height: 1.5;
        margin: 0;
        overflow-wrap: anywhere;
    }

    button, input, textarea, select { font: inherit; }
    input, textarea, select { background: var(--surface); color: var(--text); }
    h1, h2, h3 { font-family: 'Montserrat Variable', system-ui, -apple-system, 'Segoe UI', sans-serif; font-weight: 400; }
    a { color: var(--primary); }

    /* Soft halo instead of a hard rim; the transparent outline survives forced colors */
    :focus-visible { box-shadow: 0 0 0 5px var(--halo); outline: 2px solid transparent; }
    button, a, summary, select { -webkit-tap-highlight-color: transparent; }

    .visually-hidden {
        clip-path: inset(50%);
        height: 1px;
        overflow: hidden;
        position: absolute;
        white-space: nowrap;
        width: 1px;
    }

    @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { animation-duration: 0.01ms !important; scroll-behavior: auto !important; transition: none !important; }
    }
`

createRoot( document.getElementById( `root` ) ).render(
    <StrictMode>
        <GlobalStyle />
        <App />
    </StrictMode>,
)
