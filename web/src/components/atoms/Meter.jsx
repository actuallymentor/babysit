import styled from 'styled-components'
import { format_percent, load_level } from '../../modules/usage.js'

const LEVEL_COLORS = { calm: `var(--accent)`, warning: `var(--warning)`, critical: `var(--critical)` }

const Track = styled.div`
    background: var(--soft);
    border-radius: 999px;
    height: 0.375rem;
    overflow: hidden;
`

const Fill = styled.div`
    background: ${ ( { $level } ) => LEVEL_COLORS[ $level ] };
    border-radius: inherit;
    height: 100%;
    transition: width 320ms ease;
`

/**
 * Thin load bar; the percentage is always written beside it, never color alone.
 * @param {Object} props
 * @param {number} props.percent - Share used, 0–100
 * @param {string} props.label - Accessible name
 */
export function Meter( { percent, label } ) {
    const clamped = Math.min( 100, Math.max( 0, percent ) )

    return <Track aria-label={ label } aria-valuemax={ 100 } aria-valuemin={ 0 } aria-valuenow={ Math.round( clamped ) } aria-valuetext={ format_percent( clamped ) } role="meter">
        <Fill $level={ load_level( clamped / 100 ) } style={ { width: `${ clamped }%` } } />
    </Track>
}
