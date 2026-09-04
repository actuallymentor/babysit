import styled from 'styled-components'

const Badge = styled.span`
    align-items: center;
    background: ${ ( { $tone } ) => $tone === `active` ? `#d9efe6` : $tone === `busy` ? `#f8e5bc` : `#e4e7e5` };
    border-radius: 999rem;
    color: #22302d;
    display: inline-flex;
    font-size: 0.78rem;
    font-weight: 700;
    gap: 0.4rem;
    letter-spacing: 0.12em;
    min-height: 1.75rem;
    padding: 0.2em 0.75em;
    text-transform: uppercase;

    &::before {
        background: ${ ( { $tone } ) => $tone === `active` ? `#28795d` : $tone === `busy` ? `#9a6718` : `#68716e` };
        border-radius: 50%;
        content: '';
        height: 0.5rem;
        width: 0.5rem;
    }
`

/** Displays activity without relying on color alone. */
export function Status( { activity, busy } ) {
    const label = busy ? `Busy` : activity === `idle` ? `Idle` : `Running`
    const tone = busy ? `busy` : activity === `running` ? `active` : `idle`
    return <Badge $tone={ tone }>{ label }</Badge>
}
