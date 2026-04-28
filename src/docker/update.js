import { run } from '../utils/exec.js'
import { log } from '../utils/log.js'

// Docker Hub repo published by .github/workflows/docker.yml
const DOCKER_IMAGE = `actuallymentor/babysit`

/**
 * Pull the latest babysit docker image
 * @param {string} [tag='latest'] - Image tag to pull
 * @returns {Promise<void>}
 */
export const pull_image = async ( tag = `latest` ) => {

    const image = `${ DOCKER_IMAGE }:${ tag }`

    try {
        log.debug( `Pulling docker image: ${ image }` )
        await run( `docker`, [ `pull`, image ], {}, 120_000 )
        log.info( `Docker image up to date: ${ image }` )
    } catch ( e ) {
        log.warn( `Failed to pull docker image: ${ e.message }` )
    }

}

/**
 * Get the image name with tag
 * @param {string} [tag='latest'] - Image tag
 * @returns {string}
 */
export const get_image_name = ( tag = `latest` ) => `${ DOCKER_IMAGE }:${ tag }`
