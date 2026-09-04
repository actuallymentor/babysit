import styled from 'styled-components'

export const Button = styled.button`
    align-items: center;
    background: ${ ( { $quiet } ) => $quiet ? `transparent` : `#15221f` };
    border: 1px solid ${ ( { $quiet } ) => $quiet ? `#b7bfbc` : `#15221f` };
    border-radius: 0.7rem;
    color: ${ ( { $quiet } ) => $quiet ? `#23312e` : `#ffffff` };
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-weight: 700;
    justify-content: center;
    letter-spacing: 0.12em;
    min-height: 3rem;
    padding: 0.65em 1.1em;

    &:disabled {
        cursor: not-allowed;
        opacity: 0.5;
    }

    &:focus-visible {
        outline: 3px solid #7ec0d0;
        outline-offset: 2px;
    }
`
