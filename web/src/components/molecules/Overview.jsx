import styled from 'styled-components'
import { Meter } from '../atoms/Meter.jsx'
import { amount_label, format_memory, format_percent, reset_label, used_percent } from '../../modules/usage.js'

const Layout = styled.div`
    align-items: start;
    display: grid;
    gap: 0.8rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
    margin-bottom: 2rem;
`

const Panel = styled.section`
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.35rem;
    display: grid;
    align-content: start;
    gap: 1rem;
    padding: 1rem;

    > h2 {
        color: var(--muted);
        font-size: 0.8rem;
        margin: 0;
        text-transform: uppercase;
    }
`

const Stats = styled.dl`
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    margin: 0;

    div { display: grid; gap: 0.25rem; align-content: start; }
    dt { color: var(--muted); font-size: 0.85em; }
    dd { font-size: 1.35em; margin: 0; font-variant-numeric: tabular-nums; }
    small { color: var(--muted); font-size: 0.8em; }
`

const Agent = styled.div`
    display: grid;
    gap: 0.75rem;

    & + & { border-top: 1px solid var(--soft); padding-top: 1rem; }

    h3 { font-size: 1em; margin: 0; }
    h3 small { color: var(--muted); font-family: 'Nunito Variable', system-ui, sans-serif; font-size: 0.85em; text-transform: none; }
`

const Limit = styled.div`
    display: grid;
    gap: 0.35rem;
`

const LimitHeader = styled.div`
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    justify-content: space-between;
    font-size: 0.9em;

    span:last-child { font-variant-numeric: tabular-nums; }
`

const Muted = styled.p`
    color: var(--muted);
    font-size: 0.85em;
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
function Containers( { containers } ) {
    const { cpu_percent, host_cpus, host_memory_bytes, memory_bytes, sampled, sessions } = containers
    const memory_share = memory_bytes !== null && host_memory_bytes ? memory_bytes / host_memory_bytes * 100 : null

    return <Panel aria-labelledby="containers-heading">
        <h2 id="containers-heading">Containers</h2>
        <Stats>
            <div>
                <dt>Running</dt>
                <dd>{ sessions }</dd>
                <small>{ sampled === sessions ? `All sampled` : `${ sampled } sampled` }</small>
            </div>
            <div>
                <dt>CPU</dt>
                <dd>{ cpu_percent === null ? `–` : format_percent( cpu_percent ) }</dd>
                { cpu_percent !== null && <Meter label="Total container CPU" percent={ cpu_percent } /> }
                <small>{ host_cpu_label( host_cpus ) }</small>
            </div>
            <div>
                <dt>Memory</dt>
                <dd>{ memory_bytes === null ? `–` : format_memory( memory_bytes ) }</dd>
                { memory_share !== null && <Meter label="Total container memory" percent={ memory_share } /> }
                <small>{ host_memory_bytes ? `of ${ format_memory( host_memory_bytes ) }` : `of host` }</small>
            </div>
        </Stats>
    </Panel>
}

/** One provider limit: name, share used, reset and any raw amount. */
function LimitRow( { limit } ) {
    const percent = used_percent( limit )
    const details = [ amount_label( limit ), limit.resets_at && reset_label( limit.resets_at ) ].filter( Boolean )

    return <Limit>
        <LimitHeader>
            <span>{ limit.name }</span>
            <span>{ percent === null ? details.shift() || `Not reported` : `${ format_percent( percent ) } used` }</span>
        </LimitHeader>
        { percent !== null && <Meter label={ `${ limit.name } used` } percent={ percent } /> }
        { details.length > 0 && <Muted>{ details.join( ` · ` ) }</Muted> }
    </Limit>
}

/** Account rate limits per authenticated agent, as last fetched by a host monitor. */
function AccountUsage( { usage } ) {
    const agents = usage?.agents.filter( agent => agent.status !== `unauthenticated` ) || []

    return <Panel aria-labelledby="usage-heading">
        <h2 id="usage-heading">Account usage</h2>

        { !usage && <Muted>Limits appear once a session monitor refreshes them, every 5 minutes.</Muted> }
        { usage && agents.length === 0 && <Muted>No signed-in agents on the host.</Muted> }

        { agents.map( agent => <Agent key={ `${ agent.agent }-${ agent.provider }` }>
            <h3>{ AGENT_NAMES[ agent.agent ] || agent.agent } { agent.provider && <small>{ agent.provider }</small> }</h3>
            { agent.limits.map( limit => <LimitRow key={ limit.name } limit={ limit } /> ) }
            { agent.limits.length === 0 && <Muted>{ STATUS_TEXT[ agent.status ] || `No limits reported` }{ agent.message ? ` — ${ agent.message }` : `` }</Muted> }
        </Agent> ) }

        { usage?.stale && <Muted role="status">Figures are over 15 minutes old.</Muted> }
    </Panel>
}

/** Host overview above the session list. */
export function Overview( { status } ) {
    return <Layout>
        <Containers containers={ status.containers } />
        <AccountUsage usage={ status.usage } />
    </Layout>
}
