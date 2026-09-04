const parse_response = async response => {
    const body = await response.json().catch( () => ( {} ) )
    if( !response.ok ) throw Object.assign( new Error( body.error || `Request failed` ), { status_code: response.status } )
    return body
}

/**
 * Calls a same-origin Babysit Web API endpoint.
 * @param {string} path - API path
 * @param {RequestInit} options - Fetch options
 * @returns {Promise<Object>} Parsed response body
 */
export const api = async ( path, options={} ) => {
    const headers = options.body ? { 'Content-Type': `application/json`, ...options.headers } : options.headers
    const response = await fetch( path, { ...options, credentials: `same-origin`, headers } )
    if( response.status === 401 && path !== `/api/login` && typeof window !== `undefined` ) window.dispatchEvent( new Event( `babysit-auth-expired` ) )
    return parse_response( response )
}
