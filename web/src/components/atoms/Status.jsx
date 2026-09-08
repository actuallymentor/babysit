import styled from 'styled-components'

const Badges = styled.span`
    display: inline-flex;
    flex-wrap: wrap;
    flex-shrink: 0;
    max-width: 100%;
    gap: 0.4rem;
`

const Badge = styled.span`
    align-items: center;
    background: var(--soft);
    border: 1px solid var(--border);
    border-radius: 0.25rem;
    color: var(--text);
    display: inline-flex;
    font-size: 0.8em;
    font-weight: 700;
    min-height: 1.75rem;
    padding: 0.2em 0.6em;
`

/** Keeps observed agent activity separate from the send lock. */
export function Status( { activity, busy } ) {
    const label = activity === `idle` ? `Idle` : activity === `running` ? `Running` : `Activity unknown`
    return <Badges>
        <Badge>{ label }</Badge>
        { busy && <Badge>Sending paused</Badge> }
    </Badges>
}
