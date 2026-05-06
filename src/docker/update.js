import { run } from '../utils/exec.js'
import { log } from '../utils/log.js'

// Docker Hub repo published by .github/workflows/docker.yml
const DOCKER_IMAGE = `actuallymentor/babysit`

/**
 * Resolve the Docker image Babysit should run.
 * @param {string} [tag='latest'] - Image tag for the published image
 * @returns {string} Full image reference
 */
export const get_image_name = ( tag = `latest` ) => process.env.BABYSIT_DOCKER_IMAGE || `${ DOCKER_IMAGE }:${ tag }`

/**
 * Pull the latest babysit docker image
 * @param {string} [tag='latest'] - Image tag to pull
 * @returns {Promise<void>}
 */
export const pull_image = async ( tag = `latest` ) => {

    const image = get_image_name( tag )

    try {
        log.debug( `Pulling docker image: ${ image }` )
        await run( `docker`, [ `pull`, image ], {}, 120_000 )
        log.info( `Docker image up to date: ${ image }` )
    } catch ( e ) {
        log.warn( `Failed to pull docker image: ${ e.message }` )
    }

}
