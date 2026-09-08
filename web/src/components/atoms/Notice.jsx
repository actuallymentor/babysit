import styled from 'styled-components'

export const Notice = styled.div`
    background: ${ ( { $error } ) => $error ? `var(--danger-bg)` : `var(--soft)` };
    border-radius: 0.3rem;
    color: ${ ( { $error } ) => $error ? `var(--danger)` : `var(--text)` };
    line-height: 1.5;
    padding: 0.8rem 1rem;
`
