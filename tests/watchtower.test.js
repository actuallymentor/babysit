import { describe, expect, it } from 'bun:test'

import {
    COMPATIBLE_WATCHTOWER_IMAGE_REPOSITORIES,
    find_unrecognized_watchtower_containers,
    inspect_running_watchtower_containers,
    is_compatible_watchtower_image,
    normalise_docker_image_repository,
    parse_docker_ps_output,
    warn_if_unrecognized_watchtower_is_running,
} from '../src/docker/watchtower.js'

const docker_row = ( name, image ) => JSON.stringify( { Names: name, Image: image } )

describe( `Watchtower compatibility`, () => {

    it( `normalizes tags, digests, and Docker Hub registry aliases`, () => {

        expect( normalise_docker_image_repository( `containrrr/watchtower:1.7.1` ) )
            .toBe( `containrrr/watchtower` )
        expect( normalise_docker_image_repository( `docker.io/nickfedor/watchtower@sha256:abc` ) )
            .toBe( `nickfedor/watchtower` )
        expect( normalise_docker_image_repository( `localhost:5000/team/watchtower:latest` ) )
            .toBe( `localhost:5000/team/watchtower` )

    } )

    it( `recognizes confirmed Watchtower repositories with tags and digests`, () => {

        COMPATIBLE_WATCHTOWER_IMAGE_REPOSITORIES.forEach( repository => {
            expect( is_compatible_watchtower_image( `${ repository }:latest` ) ).toBe( true )
            expect( is_compatible_watchtower_image( `${ repository }@sha256:abc` ) ).toBe( true )
        } )

        expect( is_compatible_watchtower_image( `index.docker.io/containrrr/watchtower:1.7.1` ) ).toBe( true )

    } )

    it( `does not trust legacy or similarly named repositories`, () => {

        expect( is_compatible_watchtower_image( `v2tec/watchtower:latest` ) ).toBe( false )
        expect( is_compatible_watchtower_image( `centurylink/watchtower:latest` ) ).toBe( false )
        expect( is_compatible_watchtower_image( `unknown/watchtower:latest` ) ).toBe( false )
        expect( is_compatible_watchtower_image( `registry.example/containrrr/watchtower:latest` ) ).toBe( false )

    } )

    it( `finds unknown Watchtower names and images while ignoring unrelated containers`, () => {

        const containers = [
            { name: `safe`, image: `containrrr/watchtower:latest` },
            { name: `WatchTower`, image: `vendor/renamed-agent:latest` },
            { name: `updater`, image: `vendor/watchtower-pro:latest` },
            { name: `database`, image: `postgres:17` },
        ]

        expect( find_unrecognized_watchtower_containers( containers ) ).toEqual( [
            { name: `WatchTower`, image: `vendor/renamed-agent:latest` },
            { name: `updater`, image: `vendor/watchtower-pro:latest` },
        ] )

    } )

} )

describe( `Watchtower Docker inspection`, () => {

    it( `parses valid Docker rows and skips malformed output`, () => {

        const output = [
            docker_row( `watchtower`, `nickfedor/watchtower:latest` ),
            `not-json`,
            docker_row( `app`, `example/app:latest` ),
        ].join( `\n` )

        expect( parse_docker_ps_output( output ) ).toEqual( {
            containers: [
                { name: `watchtower`, image: `nickfedor/watchtower:latest` },
                { name: `app`, image: `example/app:latest` },
            ],
            invalid_rows: 1,
        } )

    } )

    it( `inspects running containers through the Docker CLI`, () => {

        const inspection = inspect_running_watchtower_containers( {
            env: {},
            spawn_sync: ( cmd, args, options ) => {
                expect( cmd ).toBe( `docker` )
                expect( args ).toEqual( [ `ps`, `--format`, `{{json .}}` ] )
                expect( options.stdio ).toEqual( [ `ignore`, `pipe`, `pipe` ] )

                return {
                    status: 0,
                    stdout: [
                        docker_row( `watchtower`, `containrrr/watchtower:latest` ),
                        docker_row( `other-watchtower`, `vendor/updater:latest` ),
                    ].join( `\n` ),
                }
            },
        } )

        expect( inspection ).toEqual( {
            containers: [ { name: `other-watchtower`, image: `vendor/updater:latest` } ],
            invalid_rows: 0,
            error: null,
        } )

    } )

    it( `honors sudo-routed Docker hosts`, () => {

        inspect_running_watchtower_containers( {
            env: { BABYSIT_DOCKER_USE_SUDO: `1` },
            spawn_sync: ( cmd, args ) => {
                expect( cmd ).toBe( `sudo` )
                expect( args ).toEqual( [ `docker`, `ps`, `--format`, `{{json .}}` ] )
                return { status: 0, stdout: `` }
            },
        } )

    } )

    it( `treats Docker inspection failures as nonfatal`, () => {

        expect( inspect_running_watchtower_containers( {
            spawn_sync: () => ( {
                status: 1,
                stderr: `daemon unavailable\n`,
            } ),
        } ) ).toEqual( {
            containers: [],
            invalid_rows: 0,
            error: `daemon unavailable`,
        } )

    } )

    it( `logs an unmistakable warning for unknown Watchtower containers`, () => {

        const warnings = []
        const debug = []
        const containers = warn_if_unrecognized_watchtower_is_running( {
            logger: {
                warn: message => warnings.push( message ),
                debug: message => debug.push( message ),
            },
            spawn_sync: () => ( {
                status: 0,
                stdout: docker_row( `mystery-watchtower`, `vendor/mystery:latest` ),
            } ),
        } )

        expect( containers ).toEqual( [
            { name: `mystery-watchtower`, image: `vendor/mystery:latest` },
        ] )
        expect( warnings.join( `\n` ) ).toContain( `UNRECOGNIZED WATCHTOWER CONTAINER DETECTED` )
        expect( warnings.join( `\n` ) ).toContain( `I see a Watchtower container that I don't recognize` )
        expect( warnings.join( `\n` ) ).toContain( `This might kill Babysit` )
        expect( warnings.join( `\n` ) ).toContain( `mystery-watchtower` )
        expect( warnings.join( `\n` ) ).toContain( `vendor/mystery:latest` )
        expect( debug ).toEqual( [] )

    } )

    it( `logs inspection problems only at debug level`, () => {

        const warnings = []
        const debug = []
        const containers = warn_if_unrecognized_watchtower_is_running( {
            logger: {
                warn: message => warnings.push( message ),
                debug: message => debug.push( message ),
            },
            spawn_sync: () => ( {
                error: new Error( `docker timed out` ),
            } ),
        } )

        expect( containers ).toEqual( [] )
        expect( warnings ).toEqual( [] )
        expect( debug.join( `\n` ) ).toContain( `docker timed out` )

    } )

} )
