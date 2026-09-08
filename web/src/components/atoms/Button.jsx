import styled from 'styled-components'

export const Button = styled.button`
    align-items: center;
    background: ${ ( { $quiet } ) => $quiet ? `transparent` : `var(--primary)` };
    border: 1px solid ${ ( { $quiet } ) => $quiet ? `var(--border)` : `var(--primary)` };
    border-radius: 0.3rem;
    color: ${ ( { $quiet } ) => $quiet ? `var(--text)` : `var(--on-primary)` };
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-weight: 700;
    justify-content: center;
    letter-spacing: normal;
    min-height: 3rem;
    padding: 0.65em 1.1em;

    &:disabled {
        cursor: not-allowed;
        opacity: 0.5;
    }

    &:focus-visible {
        outline: 3px solid var(--primary);
        outline-offset: 2px;
    }
`
