import { useState } from 'react'
import styled from 'styled-components'
import { Button } from '../atoms/Button.jsx'
import { Notice } from '../atoms/Notice.jsx'

const Page = styled.main`
    align-items: center;
    display: flex;
    justify-content: center;
    min-height: 100dvh;
    padding: 1.5rem;
`

const Card = styled.form`
    background: #ffffff;
    border: 1px solid #d8ddda;
    border-radius: 1rem;
    box-shadow: 0 1rem 3rem rgba(21, 34, 31, 0.08);
    display: grid;
    gap: 1rem;
    max-width: 28rem;
    padding: clamp(1.25rem, 5vw, 2.5rem);
    width: 100%;

    h1 { margin: 0; }
    p { line-height: 1.6; margin: 0; }
    label { display: grid; font-weight: 700; gap: 0.45rem; }
    input {
        border: 1px solid #9da8a4;
        border-radius: 0.6rem;
        font: inherit;
        min-height: 3.1rem;
        padding: 0.65rem 0.8rem;
        width: 100%;
    }
    input:focus { border-color: #356b77; outline: 3px solid #d5ecf1; }
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
            <div>
                <h1>Babysit</h1>
                <p>Enter the access key from the host.</p>
            </div>
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
            <Button disabled={ is_loading } type="submit">{ is_loading ? `Checking…` : `Open Babysit` }</Button>
        </Card>
    </Page>
}
