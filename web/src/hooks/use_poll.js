import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Polls one async resource while the page is visible.
 * @param {Function} load - Async loader
 * @param {Array} dependencies - Values that rebuild the loader
 * @param {number} interval_ms - Poll interval
 * @returns {Object} Data, error, loading state, and manual reload
 */
export const use_poll = ( load, dependencies=[], interval_ms=2_000 ) => {
    const [ data, set_data ] = useState( null )
    const [ error, set_error ] = useState( null )
    const [ is_loading, set_is_loading ] = useState( true )
    const request_sequence = useRef( 0 )
    const is_pending = useRef( false )

    const reload = useCallback( async () => {
        const request = ++request_sequence.current
        is_pending.current = true
        try {
            const loaded_data = await load()
            // A slow older poll must never replace a newer reply or send lock.
            if( request !== request_sequence.current ) return
            set_data( loaded_data )
            set_error( null )
        } catch ( load_error ) {
            if( request !== request_sequence.current ) return
            set_error( load_error )
        } finally {
            if( request === request_sequence.current ) {
                is_pending.current = false
                set_is_loading( false )
            }
        }
    }, dependencies )

    useEffect( () => {
        reload()
        const timer = window.setInterval( () => {
            if( document.visibilityState === `visible` && !is_pending.current ) reload()
        }, interval_ms )

        const refresh_visible = () => document.visibilityState === `visible` && reload()
        document.addEventListener( `visibilitychange`, refresh_visible )
        window.addEventListener( `online`, reload )

        return () => {
            ++request_sequence.current
            is_pending.current = false
            window.clearInterval( timer )
            document.removeEventListener( `visibilitychange`, refresh_visible )
            window.removeEventListener( `online`, reload )
        }
    }, [ interval_ms, reload ] )

    return { data, error, is_loading, reload }
}
