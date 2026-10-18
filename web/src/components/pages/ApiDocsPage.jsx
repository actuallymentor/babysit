import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { ChevronLeft } from 'lucide-react'
import { MarkdownMessage } from '../molecules/MarkdownMessage.jsx'
import { PageHeading } from '../atoms/Layout.jsx'

const Back = styled( Link )`
    align-items: center;
    border-radius: 0.5rem;
    color: var(--primary);
    display: inline-flex;
    font-weight: 600;
    gap: 0.25rem;
    margin: -0.5rem 0 0.5rem -0.25rem;
    min-height: 2.75rem;
    padding: 0 0.25rem;
    text-decoration: none;

    svg { height: 1rem; width: 1rem; }
`

// Built from this page's origin, so every example runs as pasted
const reference = origin => `
## 1. Create a key

API keys are read-only and managed on the Babysit host:

\`\`\`
babysit web key add grafana    # prints the key once
babysit web key list
babysit web key remove grafana # stops working at once
\`\`\`

## 2. Call the API

\`\`\`
curl -H "Authorization: Bearer $BABYSIT_KEY" ${ origin }/api/status
\`\`\`

| Endpoint | Returns |
|---|---|
| \`GET /api/status\` | Sessions, container CPU/MEM totals and account usage |
| \`GET /api/sessions\` | \`{ sessions[] }\`, each with container stats |
| \`GET /api/sessions/:id\` | \`{ session, pending }\`: one session, its last reply and queued messages |
| \`GET /api/me\` | \`{ role }\`, always \`read\` for API keys |

## Errors

| Code | Meaning |
|---|---|
| 401 | Missing, unknown or removed key |
| 403 | Not a GET request: API keys never send messages |
| 404 | Unknown route, or the session is stale |

## \`/api/status\` shape

\`\`\`
{
  generated_at,
  sessions: [ { session_id, name, agent, modifiers, directory, activity, busy, attachment, updated_at, container } ],
  containers: { sessions, sampled, cpu_percent, memory_bytes, host_cpus, host_memory_bytes },
  usage: { fetched_at, stale, agents: [ { agent, provider, status, message, limits[] } ] } | null
}
\`\`\`

Usage refreshes every 5 minutes on the host; container figures every 30 seconds.
`

/** How to read Babysit's JSON API with a read-only key. */
export function ApiDocsPage() {
    return <>
        <Back to="/"><ChevronLeft aria-hidden="true" strokeWidth={ 1.5 } />Sessions</Back>
        <PageHeading>
            <h1>API</h1>
            <p>Read sessions and usage as JSON from scripts and dashboards.</p>
        </PageHeading>
        <MarkdownMessage>{ reference( window.location.origin ) }</MarkdownMessage>
    </>
}
