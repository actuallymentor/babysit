import { useState } from 'react'
import styled from 'styled-components'
import { Button } from '../atoms/Button.jsx'
import { Notice } from '../atoms/Notice.jsx'
import { Surface } from '../atoms/Layout.jsx'

const Page = styled.main`
    align-items: center;
    display: flex;
    justify-content: center;
    min-height: 100dvh;
    padding: 1.5rem 1rem;
`

const Card = styled( Surface ).attrs( { as: `form` } )`
    display: grid;
    gap: 1.5rem;
    max-width: 24rem;
    padding: clamp(1.25rem, 5vw, 2rem);
    width: 100%;

    header { display: grid; gap: 0.25rem; justify-items: start; }
    img { height: 2.5rem; margin-bottom: 0.5rem; width: 2.5rem; }
    h1 { font-size: 1.625rem; margin: 0; }
    p { color: var(--muted); margin: 0; }
    code { background: var(--soft); border-radius: 0.25rem; color: var(--text); font-size: 0.875em; padding: 0.1em 0.3em; white-space: nowrap; }
    label { display: grid; font-weight: 500; gap: 0.375rem; }
    input {
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        font: inherit;
        min-height: 2.75rem;
        padding: 0 0.75rem;
        transition: border-color 160ms ease, box-shadow 160ms ease;
        width: 100%;
    }
    input:focus { border-color: var(--accent); box-shadow: 0 0 0 5px var(--halo); outline: 2px solid transparent; }
    form > button, > button { justify-self: stretch; }
`

const Fields = styled.div`
    display: grid;
    gap: 1rem;
`

/** Collects the one-time access key without persisting it in the browser. */
export function LoginPage( { login } ) {
    const [ token, set_token ] = useState( `` )
    const [ error, set_error ] = useState( null )
    const [ is_loading, set_is_loading ] = useState( false )

    const authenticate = async event => {
        event.preventDefault()
        set_error( null )
        set_is_loading( true )

        try {
            await login( token )
            set_token( `` )
        } catch ( login_error ) {
            set_error( login_error.message )
        } finally {
            set_is_loading( false )
        }
    }

    return <Page>
        <Card onSubmit={ authenticate }>
            <header>
                <img alt="" src="/icon.svg" />
                <h1>Babysit</h1>
                <p>Enter the access key from <code>babysit web init</code>.</p>
            </header>
            <Fields>
                { error && <Notice $error role="alert">{ error }</Notice> }
                <label>
                    Access key
                    <input
                        autoComplete="current-password"
                        autoFocus
                        name="access-key"
                        onChange={ event => set_token( event.target.value ) }
                        required
                        type="password"
                        value={ token }
                    />
                </label>
            </Fields>
            <Button disabled={ is_loading } type="submit">{ is_loading ? `Checking…` : `Open Babysit` }</Button>
        </Card>
    </Page>
}
