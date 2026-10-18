import { Activity, CircleHelp, CirclePause, Hourglass, Moon } from 'lucide-react'
import styled from 'styled-components'

const Pills = styled.span`
    align-items: flex-start;
    display: inline-flex;
    flex-shrink: 0;
    flex-wrap: wrap;
    gap: 0.375rem;
    max-width: 100%;
`

// Tint from the tone, text in its readable shade; the icon carries meaning too
const Pill = styled.span`
    align-items: center;
    background: color-mix(in srgb, ${ ( { $tone } ) => $tone } 16%, transparent);
    border-radius: 999px;
    color: ${ ( { $text } ) => $text };
    display: inline-flex;
    font-size: 0.8125rem;
    font-weight: 600;
    gap: 0.3rem;
    line-height: 1.3;
    padding: 0.15rem 0.55rem 0.15rem 0.45rem;
    white-space: nowrap;

    svg { height: 0.875rem; width: 0.875rem; }
`

const ACTIVITY = {
    idle: { icon: Moon, label: `Idle`, text: `var(--muted)`, tone: `var(--muted)` },
    running: { icon: Activity, label: `Running`, text: `var(--primary)`, tone: `var(--accent)` },
    waiting: { icon: Hourglass, label: `Waiting`, text: `var(--warning-text)`, tone: `var(--warning)` },
    unknown: { icon: CircleHelp, label: `Activity unknown`, text: `var(--muted)`, tone: `var(--muted)` },
}

/** Keeps observed agent activity separate from the send lock. */
export function Status( { activity, busy } ) {
    const { icon: Icon, label, text, tone } = ACTIVITY[ activity ] || ACTIVITY.unknown

    return <Pills>
        <Pill $text={ text } $tone={ tone }><Icon aria-hidden="true" strokeWidth={ 1.5 } />{ label }</Pill>
        { busy && <Pill $text="var(--muted)" $tone="var(--muted)"><CirclePause aria-hidden="true" strokeWidth={ 1.5 } />Sending paused</Pill> }
    </Pills>
}
