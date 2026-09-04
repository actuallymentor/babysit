import { registerSW } from 'virtual:pwa-register'

let update_app = async () => undefined

/** Registers the service worker and reports when a new shell is waiting. */
export const register_pwa = notify_update => {
    update_app = registerSW( {
        immediate: true,
        onNeedRefresh: () => notify_update( true ),
        onRegisteredSW: ( _, registration ) => {
            if( !registration ) return
            window.setInterval( () => registration.update(), 60 * 60 * 1_000 )
        },
    } )
}

/** Activates the waiting PWA shell. */
export const activate_update = async () => update_app( true )

/** Removes every old app worker/cache and reloads from the network. */
export const force_update = async () => {
    const registrations = `serviceWorker` in navigator ? await navigator.serviceWorker.getRegistrations() : []
    await Promise.all( registrations.map( registration => registration.unregister() ) )

    const cache_names = `caches` in window ? await caches.keys() : []
    await Promise.all( cache_names.map( cache_name => caches.delete( cache_name ) ) )
    window.location.reload()
}
