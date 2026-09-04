import styled from 'styled-components'

const Pill = styled.button`
    background: #7ec0d0;
    border: 0;
    border-radius: 999rem;
    bottom: calc(1rem + env(safe-area-inset-bottom));
    box-shadow: 0 0.35rem 1.2rem rgba(21, 34, 31, 0.2);
    color: #15221f;
    cursor: pointer;
    font: inherit;
    font-weight: 800;
    left: 1rem;
    min-height: 3rem;
    padding: 0.65em 1.1em;
    position: fixed;
    z-index: 4;
`

/** Shows the browser-native install action when it is available. */
export function InstallPill( { can_install, install } ) {
    if( !can_install ) return null
    return <Pill onClick={ install }>Install app</Pill>
}
