import { Info, TriangleAlert } from 'lucide-react'
import styled from 'styled-components'

const Box = styled.div`
    align-items: flex-start;
    background: ${ ( { $error } ) => $error ? `var(--danger-bg)` : `var(--soft)` };
    border-radius: 0.5rem;
    color: ${ ( { $error } ) => $error ? `var(--danger)` : `var(--text)` };
    display: flex;
    font-size: 0.9375rem;
    gap: 0.5rem;
    line-height: 1.5;
    padding: 0.625rem 0.875rem;

    > svg { flex-shrink: 0; height: 1rem; margin-top: 0.15em; width: 1rem; }
`

/** Tinted inline message: info by default, `$error` for failures. */
export function Notice( { $error, children, ...props } ) {
    const Icon = $error ? TriangleAlert : Info
    return <Box $error={ $error } { ...props }>
        <Icon aria-hidden="true" strokeWidth={ 1.5 } />
        <span>{ children }</span>
    </Box>
}
