import { describe, it, expect } from 'bun:test'

import {
    can_mount_host_gh_config_dir,
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

    it( `detects gh config dirs that nested Docker can safely bind`, () => {

        expect( can_mount_host_gh_config_dir( `/home/alice/.config/gh`, {} ) ).toBe( true )

        const nested_env = { BABYSIT_HOST_WORKSPACE: `/Users/alice/project` }

        expect( can_mount_host_gh_config_dir( `/workspace`, nested_env ) ).toBe( true )
        expect( can_mount_host_gh_config_dir( `/workspace/.config/gh`, nested_env ) ).toBe( true )
        expect( can_mount_host_gh_config_dir( `/home/node/.config/gh`, nested_env ) ).toBe( false )

    } )

    it( `skips non-host-visible gh config binds in nested Docker contexts`, () => {

        const mounts = setup_github_cli_credentials( {
            env: {
                HOME: `/home/node`,
                BABYSIT_HOST_WORKSPACE: `/Users/alice/project`,
            },
            exists_sync: path => path === `/home/node/.config/gh`,
            spawn_sync: () => ( { status: 1, stdout: `` } ),
        } )

        expect( mounts ).toEqual( [] )

    } )

    it( `keeps workspace gh config binds in nested Docker contexts`, () => {

        const mounts = setup_github_cli_credentials( {
            env: {
                GH_CONFIG_DIR: `/workspace/.gh`,
                BABYSIT_HOST_WORKSPACE: `/Users/alice/project`,
            },
            exists_sync: path => path === `/workspace/.gh`,
            spawn_sync: () => ( { status: 1, stdout: `` } ),
        } )

        expect( mounts ).toEqual( [
            {
                type: `volume`,
                source: `/workspace/.gh`,
                target: GH_CONFIG_CONTAINER_DIR,
                ro: true,
            },
            { type: `env`, key: `GH_CONFIG_DIR`, value: GH_CONFIG_CONTAINER_DIR },
        ] )

    } )

    it( `still extracts host gh tokens when nested config binds are skipped`, () => {

        const mounts = setup_github_cli_credentials( {
            env: {
                HOME: `/home/node`,
                BABYSIT_HOST_WORKSPACE: `/Users/alice/project`,
            },
            exists_sync: path => path === `/home/node/.config/gh`,
            spawn_sync: () => ( { status: 0, stdout: `host-token\n` } ),
        } )

        expect( mounts ).toEqual( [
            { type: `env`, key: `GH_TOKEN`, value: `host-token` },
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

    it( `extracts enterprise auth when GH_HOST is enterprise but only GH_TOKEN is set`, () => {

        let calls = 0
        const mounts = setup_github_cli_credentials( {
            env: {
                HOME: `/home/alice`,
                GH_HOST: `github.internal`,
                GH_TOKEN: `public-token`,
            },
            exists_sync: () => false,
            spawn_sync: ( cmd, args ) => {
                calls += 1
                expect( cmd ).toBe( `gh` )
                expect( args ).toEqual( [ `auth`, `token`, `--hostname`, `github.internal` ] )
                return { status: 0, stdout: `enterprise-token\n` }
            },
        } )

        expect( calls ).toBe( 1 )
        expect( mounts ).toEqual( [
            { type: `env`, key: `GH_HOST`, value: `github.internal` },
            { type: `env`, key: `GH_ENTERPRISE_TOKEN`, value: `enterprise-token` },
            { type: `env`, key: `GH_TOKEN`, value: `public-token` },
        ] )

    } )

    it( `extracts public auth when only an enterprise token env var is set`, () => {

        let calls = 0
        const mounts = setup_github_cli_credentials( {
            env: {
                HOME: `/home/alice`,
                GH_ENTERPRISE_TOKEN: `enterprise-token`,
            },
            exists_sync: () => false,
            spawn_sync: ( cmd, args ) => {
                calls += 1
                expect( cmd ).toBe( `gh` )
                expect( args ).toEqual( [ `auth`, `token` ] )
                return { status: 0, stdout: `public-token\n` }
            },
        } )

        expect( calls ).toBe( 1 )
        expect( mounts ).toEqual( [
            { type: `env`, key: `GH_TOKEN`, value: `public-token` },
            { type: `env`, key: `GH_ENTERPRISE_TOKEN`, value: `enterprise-token` },
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
