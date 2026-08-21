import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

import { resolve_opencode_route_config } from '../src/agents/opencode_config.js'

const write_config = ( path, content ) => {
    mkdirSync( dirname( path ), { recursive: true } )
    writeFileSync( path, content )
}

describe( `OpenCode route config`, () => {

    it( `merges JSONC route sources in OpenCode precedence order`, () => {

        const root = mkdtempSync( join( tmpdir(), `babysit-opencode-route-test-` ) )
        const home_dir = join( root, `home` )
        const workspace = join( root, `workspace` )
        const custom_directory = join( root, `custom-directory` )
        const custom_config = join( root, `custom.jsonc` )

        try {
            write_config( join( home_dir, `.config/opencode/opencode.jsonc` ), `{
                // Preserve comments and trailing commas.
                "provider": {
                    "custom": {
                        "options": { "baseURL": "https://global.example/v1" },
                    },
                },
                "model": "custom/global",
                "instructions": ["never-stage.md"],
            }` )
            write_config( custom_config, `{
                "provider": { "custom": { "npm": "@ai-sdk/openai-compatible" } },
                "model": "custom/custom-file"
            }` )
            write_config( join( workspace, `opencode.json` ), `{
                "provider": { "custom": { "options": { "baseURL": "https://project.example/v1" } } },
                "model": "custom/project",
                "tools": { "bash": true }
            }` )
            write_config( join( workspace, `.opencode/opencode.json` ), `{
                "enabled_providers": ["custom"],
                "mcp": { "unsafe": { "enabled": true } }
            }` )
            write_config( join( custom_directory, `opencode.json` ), `{
                "disabled_providers": ["unused"],
                "model": "custom/custom-directory"
            }` )

            const route = resolve_opencode_route_config( {
                workspace,
                home_dir,
                env: {
                    OPENCODE_CONFIG: custom_config,
                    OPENCODE_CONFIG_DIR: custom_directory,
                    OPENCODE_CONFIG_CONTENT: `{
                        "model": "custom/inline",
                        "small_model": "custom/small",
                        "agent": { "unsafe": {} }
                    }`,
                },
            } )

            expect( route ).toEqual( {
                provider: {
                    custom: {
                        npm: `@ai-sdk/openai-compatible`,
                        options: { baseURL: `https://project.example/v1` },
                    },
                },
                model: `custom/inline`,
                enabled_providers: [ `custom` ],
                disabled_providers: [ `unused` ],
                small_model: `custom/small`,
            } )
            expect( route ).not.toHaveProperty( `instructions` )
            expect( route ).not.toHaveProperty( `tools` )
            expect( route ).not.toHaveProperty( `mcp` )
            expect( route ).not.toHaveProperty( `agent` )
        } finally {
            rmSync( root, { recursive: true, force: true } )
        }

    } )

    it( `keeps project routing while host preferences are isolated`, () => {

        const root = mkdtempSync( join( tmpdir(), `babysit-opencode-isolated-route-test-` ) )
        const home_dir = join( root, `home` )
        const workspace = join( root, `workspace` )

        try {
            write_config(
                join( home_dir, `.config/opencode/opencode.json` ),
                `{ "model": "host/model" }`
            )
            write_config(
                join( workspace, `opencode.json` ),
                `{ "model": "project/model" }`
            )

            expect( resolve_opencode_route_config( {
                workspace,
                home_dir,
                include_host_preferences: false,
            } ) ).toEqual( { model: `project/model` } )
        } finally {
            rmSync( root, { recursive: true, force: true } )
        }

    } )

} )
