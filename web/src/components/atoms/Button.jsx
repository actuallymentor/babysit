import styled, { css } from 'styled-components'

const quiet = css`
    background: transparent;
    border-color: var(--border);
    color: var(--text);

    &:hover:not(:disabled) { background: var(--hover); }
`

// Icon-only: a round face; the accessible name comes from aria-label
const icon = css`
    padding: 0;
    width: 2rem;
`

/**
 * Small pill. The face stays 2rem; ::before adds an invisible hit area to
 * 44px high and 4px wider each side, so neighbors need a 0.5rem gap.
 * Props: $quiet (outline), $icon (icon-only), $bare (no outline).
 */
export const Button = styled.button`
    align-items: center;
    background: var(--primary);
    border: 1px solid var(--primary);
    border-radius: 999px;
    color: var(--on-primary);
    cursor: pointer;
    display: inline-flex;
    flex-shrink: 0;
    font: inherit;
    font-size: 0.9375rem;
    font-weight: 600;
    gap: 0.375rem;
    justify-content: center;
    letter-spacing: normal;
    line-height: 1.2;
    min-height: 2rem;
    padding: 0.3em 0.875rem;
    position: relative;
    text-decoration: none;
    transition: transform 160ms ease, background 160ms ease, box-shadow 160ms ease;

    &::before {
        content: '';
        inset: -0.375rem -0.25rem;
        position: absolute;
    }

    svg { flex-shrink: 0; height: 1rem; width: 1rem; }

    ${ ( { $quiet, $bare } ) => ( $quiet || $bare ) && quiet }
    ${ ( { $bare } ) => $bare && `border-color: transparent;` }
    ${ ( { $icon } ) => $icon && icon }

    &:hover:not(:disabled) { transform: translateY(-1px); }
    &:active:not(:disabled) { transform: scale(0.985); }

    &:disabled {
        cursor: not-allowed;
        opacity: 0.5;
    }
`
