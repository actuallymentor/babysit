import { ChevronDown, Cpu, MemoryStick, Server } from 'lucide-react'
import styled from 'styled-components'
import { Meter } from '../atoms/Meter.jsx'
import { Section, SectionHeading, Surface } from '../atoms/Layout.jsx'
import { amount_label, format_memory, format_percent, limit_name, reset_label, used_percent } from '../../modules/usage.js'
import { age_label } from '../../modules/freshness.js'

const Stats = styled( Surface ).attrs( { as: `dl` } )`
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    margin: 0;
    padding: 1rem;

    > div { align-content: start; display: grid; gap: 0.375rem; min-width: 0; }
    dt { align-items: center; color: var(--muted); display: flex; font-size: 0.8125rem; gap: 0.375rem; }
    dt svg { flex-shrink: 0; height: 1rem; width: 1rem; }
    dd { font-size: 1.25rem; font-variant-numeric: tabular-nums; margin: 0; }
    small { color: var(--muted); font-size: 0.8125rem; }
`

// Collapsible: the section heading is the summary, with a turning chevron
const Collapsible = styled.details`
    > summary {
        border-radius: 0.5rem;
        cursor: pointer;
        list-style: none;
        margin: 0 -0.25rem 0.75rem;
        padding: 0.25rem;
    }
    > summary::-webkit-details-marker { display: none; }
    > summary ${ SectionHeading } { margin: 0; }
    > summary h2 { align-items: center; display: inline-flex; gap: 0.375rem; }
    > summary svg { color: var(--muted); height: 1rem; transform: rotate(-90deg); transition: transform 160ms ease; width: 1rem; }
    &[open] > summary svg { transform: none; }
`

const Agents = styled( Surface )`
    display: grid;
    gap: 0;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
    overflow: hidden;
`

const Agent = styled.div`
    align-content: start;
    border-top: 1px solid var(--line);
    display: grid;
    gap: 0.75rem;
    margin-top: -1px;
    padding: 1rem;

    h3 { font-size: 1rem; margin: 0; }
    h3 small { color: var(--muted); font-family: 'Nunito Variable', system-ui, sans-serif; font-size: 0.875rem; }
`

// Name | bar | percent on one line, reset and amount muted below
const Limit = styled.div`
    align-items: center;
    display: grid;
    font-size: 0.9375rem;
    gap: 0.25rem 0.75rem;
    grid-template-columns: 5.5rem minmax(3rem, 1fr) 3rem;

    > span:nth-child(3) { font-variant-numeric: tabular-nums; text-align: right; }
    > small { color: var(--muted); font-size: 0.8125rem; grid-column: 1 / -1; }
`

const Muted = styled.p`
    color: var(--muted);
    font-size: 0.875rem;
    margin: 0;
`

const STATUS_TEXT = {
    error: `Could not read limits`,
    unauthenticated: `Not signed in on the host`,
    unavailable: `Limits not exposed`,
}

const AGENT_NAMES = { antigravity: `Antigravity`, claude: `Claude`, codex: `Codex`, opencode: `OpenCode` }

const host_cpu_label = cores => cores ? `of ${ cores } ${ cores === 1 ? `core` : `cores` }` : `of host`

/** Totals across every live session's container. */
function Host( { containers } ) {
    const { cpu_percent, host_cpus, host_memory_bytes, memory_bytes, sampled, sessions } = containers
    const memory_share = memory_bytes !== null && host_memory_bytes ? memory_bytes / host_memory_bytes * 100 : null

    return <Section aria-labelledby="host-heading">
        <SectionHeading><h2 id="host-heading">Host</h2></SectionHeading>
        <Stats>
            <div>
                <dt><Server aria-hidden="true" strokeWidth={ 1.5 } />Containers</dt>
                <dd>{ sessions }</dd>
                <small>{ sampled === sessions ? `All sampled` : `${ sampled } sampled` }</small>
            </div>
            <div>
                <dt><Cpu aria-hidden="true" strokeWidth={ 1.5 } />CPU</dt>
                <dd>{ cpu_percent === null ? `–` : format_percent( cpu_percent ) }</dd>
                { cpu_percent !== null && <Meter label="Total container CPU" percent={ cpu_percent } /> }
                <small>{ host_cpu_label( host_cpus ) }</small>
            </div>
            <div>
                <dt><MemoryStick aria-hidden="true" strokeWidth={ 1.5 } />Memory</dt>
                <dd>{ memory_bytes === null ? `–` : format_memory( memory_bytes ) }</dd>
                { memory_share !== null && <Meter label="Total container memory" percent={ memory_share } /> }
                <small>{ host_memory_bytes ? `of ${ format_memory( host_memory_bytes ) }` : `of host` }</small>
            </div>
        </Stats>
    </Section>
}

/** One provider limit: name, bar and share used, then reset and any raw amount. */
function LimitRow( { limit, agent } ) {
    const percent = used_percent( limit )
    const name = limit_name( limit.name, agent )
    const details = [ limit.resets_at && reset_label( limit.resets_at ), amount_label( limit ) ].filter( Boolean )

    return <Limit>
        <span>{ name }</span>
        { percent !== null ? <Meter label={ `${ name } used` } percent={ percent } /> : <span /> }
        <span>{ percent === null ? `–` : format_percent( percent ) }</span>
        { details.length > 0 && <small>{ details.join( ` · ` ) }</small> }
    </Limit>
}

/** Account rate limits per authenticated agent, as last fetched by a host monitor. */
function AccountUsage( { usage } ) {
    const agents = usage?.agents.filter( agent => agent.status !== `unauthenticated` ) || []
    const age = usage?.fetched_at && age_label( usage.fetched_at )
    const updated = age && `Updated ${ age }`

    return <Section aria-labelledby="usage-heading">
        <Collapsible open>
            <summary>
                <SectionHeading>
                    <h2 id="usage-heading"><ChevronDown aria-hidden="true" strokeWidth={ 1.5 } />Account usage</h2>
                    { updated && <span>{ updated }{ usage.stale && ` · over 15 min old` }</span> }
                </SectionHeading>
            </summary>

            { !usage && <Muted>Limits appear once a session monitor refreshes them, every 5 minutes.</Muted> }
            { usage && agents.length === 0 && <Muted>No signed-in agents on the host.</Muted> }

            { agents.length > 0 && <Agents>
                { agents.map( agent => <Agent key={ `${ agent.agent }-${ agent.provider }-${ agent.account }` }>
                    <h3>{ AGENT_NAMES[ agent.agent ] || agent.agent } { agent.account && <small>· { agent.account } </small> }{ agent.provider && <small>· { agent.provider }</small> }</h3>
                    { agent.limits.map( limit => <LimitRow agent={ agent.agent } key={ limit.name } limit={ limit } /> ) }
                    { agent.limits.length === 0 && <Muted>{ STATUS_TEXT[ agent.status ] || `No limits reported` }{ agent.message ? ` — ${ agent.message }` : `` }</Muted> }
                </Agent> ) }
            </Agents> }
        </Collapsible>
    </Section>
}

/** Host totals and account limits, below the session list. */
export function Overview( { status } ) {
    return <>
        <Host containers={ status.containers } />
        <AccountUsage usage={ status.usage } />
    </>
}
