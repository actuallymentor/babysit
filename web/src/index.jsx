import '@fontsource-variable/montserrat'
import '@fontsource-variable/nunito'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createGlobalStyle } from 'styled-components'
import { App } from './App.jsx'

const GlobalStyle = createGlobalStyle`
    *, *::before, *::after { box-sizing: border-box; }

    html {
        background: #f5f3ee;
        color: #202825;
        font-size: 100%;
    }

    body {
        font-family: 'Nunito Variable', system-ui, -apple-system, 'Segoe UI', sans-serif;
        font-size: clamp(1rem, 0.96rem + 0.2vw, 1.125rem);
        letter-spacing: 0.12em;
        margin: 0;
        min-width: 20rem;
        word-spacing: 0.16em;
    }

    button, input, textarea { letter-spacing: inherit; }
    h1, h2, h3 { font-family: 'Montserrat Variable', system-ui, sans-serif; font-weight: 600; }

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
