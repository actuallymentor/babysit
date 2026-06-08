import { describe, it, expect } from 'bun:test'

import {
    GH_CONFIG_CONTAINER_DIR,
    read_host_gh_token,
    resolve_host_gh_config_dir,
    setup_github_cli_credentials,
} from '../src/credentials/github.js'

describe( `GitHub CLI credential passthrough`, () => {

    it( `resolves gh config dirs with documented precedence`, () => {

        expect( resolve_host_gh_config_dir( {
            GH_CONFIG_DIR: `/custom/gh`,
            XDG_CONFIG_HOME: `/xdg`,
            HOME: `/home/alice`,
        } ) ).toBe( `/custom/gh` )

        expect( resolve_host_gh_config_dir( {
            XDG_CONFIG_HOME: `/xdg`,
            HOME: `/home/alice`,
        } ) ).toBe( `/xdg/gh` )

        expect( resolve_host_gh_config_dir( {
            HOME: `/home/alice`,
        } ) ).toBe( `/home/alice/.config/gh` )

    } )

    it( `mounts the host gh config read-only and pins GH_CONFIG_DIR inside the container`, () => {

        const mounts = setup_github_cli_credentials( {
            env: { HOME: `/home/alice` },
            exists_sync: path => path === `/home/alice/.config/gh`,
            spawn_sync: () => ( { status: 1, stdout: `` } ),
        } )

        expect( mounts ).toEqual( [
            {
                type: `volume`,
                source: `/home/alice/.config/gh`,
                target: GH_CONFIG_CONTAINER_DIR,
                ro: true,
            },
            { type: `env`, key: `GH_CONFIG_DIR`, value: GH_CONFIG_CONTAINER_DIR },
        ] )

    } )

    it( `prefers explicit env tokens without invoking host gh`, () => {

        let calls = 0
        const mounts = setup_github_cli_credentials( {
            env: {
                HOME: `/home/alice`,
                GH_TOKEN: `env-token`,
            },
            exists_sync: () => false,
            spawn_sync: () => {
                calls += 1
                return { status: 0, stdout: `host-token\n` }
            },
        } )

        expect( calls ).toBe( 0 )
        expect( mounts ).toEqual( [
            { type: `env`, key: `GH_TOKEN`, value: `env-token` },
        ] )

    } )

    it( `extracts host gh auth into GH_TOKEN for github.com`, () => {

        const calls = []
        const token = read_host_gh_token( {
            env: { HOME: `/home/alice` },
            spawn_sync: ( cmd, args ) => {
                calls.push( { cmd, args } )
                return { status: 0, stdout: `host-token\n` }
            },
        } )

        expect( token ).toEqual( { type: `env`, key: `GH_TOKEN`, value: `host-token` } )
        expect( calls ).toEqual( [ { cmd: `gh`, args: [ `auth`, `token` ] } ] )

    } )

    it( `uses GH_ENTERPRISE_TOKEN when extracting auth for a GitHub Enterprise host`, () => {

        const calls = []
        const token = read_host_gh_token( {
            env: {
                HOME: `/home/alice`,
                GH_HOST: `github.internal`,
            },
            spawn_sync: ( cmd, args ) => {
                calls.push( { cmd, args } )
                return { status: 0, stdout: `enterprise-token\n` }
            },
        } )

        expect( token ).toEqual( { type: `env`, key: `GH_ENTERPRISE_TOKEN`, value: `enterprise-token` } )
        expect( calls ).toEqual( [
            { cmd: `gh`, args: [ `auth`, `token`, `--hostname`, `github.internal` ] },
        ] )

    } )

    it( `combines GH_HOST with extracted host gh auth`, () => {

        const mounts = setup_github_cli_credentials( {
            env: {
                HOME: `/home/alice`,
                GH_HOST: `github.internal`,
            },
            exists_sync: () => false,
            spawn_sync: () => ( { status: 0, stdout: `enterprise-token\n` } ),
        } )

        expect( mounts ).toEqual( [
            { type: `env`, key: `GH_HOST`, value: `github.internal` },
            { type: `env`, key: `GH_ENTERPRISE_TOKEN`, value: `enterprise-token` },
        ] )

    } )

} )
