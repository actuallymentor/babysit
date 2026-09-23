import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify( execFile )
const parse = value => {
    try {
        return JSON.parse( value )
    } catch {
        return null
    }
}

/** Read only native credential stores; never refresh or rewrite OAuth tokens. */
export const discover_credentials = async ( {
    env = process.env,
    home = homedir(),
    platform = process.platform,
    read_file = path => readFile( path, `utf8` ),
    run = execute,
} = {} ) => {

    const read = async path => {
        try {
            return parse( await read_file( path ) )
        } catch {
            return null
        }
    }
    const secret = async ( command, args ) => {
        try {
            const { stdout } = await run( command, args, { timeout: 5000, maxBuffer: 1024 * 1024 } )
            const value = stdout.trim()
            const envelopes = [ [ `go-keyring-base64:`, `base64` ], [ `go-keyring-encoded:`, `hex` ] ]
            const envelope = envelopes.find( ( [ prefix ] ) => value.startsWith( prefix ) )
            return parse( envelope ? Buffer.from( value.slice( envelope[0].length ), envelope[1] ).toString( `utf8` ) : value )
        } catch {
            return null
        }
    }
    const expand = path => path.replace( /^~(?=\/|$)/, home )
    const claude_home = expand( env.CLAUDE_CONFIG_DIR || join( home, `.claude` ) )
    const codex_home = expand( env.CODEX_HOME || join( home, `.codex` ) )
    const data_home = expand( env.XDG_DATA_HOME || join( home, `.local`, `share` ) )
    const [ claude_file, codex, opencode, antigravity_file ] = await Promise.all( [
        read( join( claude_home, `.credentials.json` ) ),
        read( join( codex_home, `auth.json` ) ),
        read( join( data_home, `opencode`, `auth.json` ) ),
        read( join( home, `.gemini`, `antigravity-cli`, `antigravity-oauth-token` ) ),
    ] )
    const claude_keychain = platform === `darwin`
        ? await secret( `security`, [ `find-generic-password`, `-s`, `Claude Code-credentials`, `-w` ] )
        : null
    const antigravity_keychain = platform === `darwin`
        ? await secret( `security`, [ `find-generic-password`, `-s`, `gemini`, `-a`, `antigravity`, `-w` ] )
        : await secret( `secret-tool`, [ `lookup`, `service`, `gemini`, `username`, `antigravity` ] )

    return {
        claude: claude_keychain || claude_file,
        codex,
        opencode,
        antigravity: antigravity_keychain || antigravity_file,
        env,
    }

}
