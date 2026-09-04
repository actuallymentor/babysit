import styled from 'styled-components'

export const Notice = styled.div`
    background: ${ ( { $error } ) => $error ? `#f8e4df` : `#e3f0f3` };
    border-radius: 0.7rem;
    color: ${ ( { $error } ) => $error ? `#6e2618` : `#233d43` };
    line-height: 1.5;
    padding: 0.8rem 1rem;
`
