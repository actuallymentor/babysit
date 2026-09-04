import { useCallback, useEffect, useState } from 'react'

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

    const reload = useCallback( async () => {
        try {
            const loaded_data = await load()
            set_data( loaded_data )
            set_error( null )
        } catch ( load_error ) {
            set_error( load_error )
        } finally {
            set_is_loading( false )
        }
    }, dependencies )

    useEffect( () => {
        reload()
        const timer = window.setInterval( () => {
            if( document.visibilityState === `visible` ) reload()
        }, interval_ms )

        const refresh_visible = () => document.visibilityState === `visible` && reload()
        document.addEventListener( `visibilitychange`, refresh_visible )

        return () => {
            window.clearInterval( timer )
            document.removeEventListener( `visibilitychange`, refresh_visible )
        }
    }, [ interval_ms, reload ] )

    return { data, error, is_loading, reload }
}
