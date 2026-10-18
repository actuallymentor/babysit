import styled from 'styled-components'

/** Raised content surface: white on the light page, deep blue on dark. */
export const Surface = styled.div`
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 0.75rem;
`

/** Page title with a muted line under it. */
export const PageHeading = styled.header`
    display: grid;
    gap: 0.25rem;
    margin-bottom: 1.5rem;

    h1 { font-size: 1.625rem; line-height: 1.25; margin: 0; overflow-wrap: anywhere; }
    p { color: var(--muted); font-size: 0.9375rem; margin: 0; }
`

/** Section title row: heading left, optional muted aside right. */
export const SectionHeading = styled.div`
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    justify-content: space-between;
    margin: 0 0 0.75rem;

    h2 { font-size: 1.125rem; margin: 0; }
    span { color: var(--muted); font-size: 0.875rem; }
`

/** Page sections: generous space between groups. */
export const Section = styled.section`
    margin-top: 2rem;
`
