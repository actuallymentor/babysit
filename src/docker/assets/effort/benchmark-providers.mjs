import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { discover_credentials } from '../usage/credentials.mjs'

const installed = async name => {
    const found = await Promise.all( ( process.env.PATH || `` ).split( delimiter ).map( async path => {
        try {
            await access( join( path, name ), constants.X_OK )
            return true
        } catch {
            return false
        }
    } ) )
    return found.some( Boolean )
}

const creator_names = {
    openai: `OpenAI`, anthropic: `Anthropic`, google: `Google`,
    deepseek: `DeepSeek`, mistral: `Mistral`, cohere: `Cohere`,
    xai: `SpaceXAI`, alibaba: `Alibaba`, moonshotai: `Kimi`,
    minimax: `MiniMax`, zai: `Z AI`, 'zai-coding-plan': `Z AI`,
}

/** Credential discovery is local/read-only; never authenticate by making paid inference calls. */
export const benchmark_providers = async ( { discover = discover_credentials, has_cli = installed } = {} ) => {
    const auth = await discover()
    const env = auth.env || {}
    const [ codex, claude, agy, opencode ] = await Promise.all( [ `codex`, `claude`, `agy`, `opencode` ].map( has_cli ) )
    const providers = new Set()
    if( codex && ( auth.codex?.tokens?.access_token || auth.codex?.OPENAI_API_KEY || env.OPENAI_API_KEY || env.CODEX_API_KEY ) ) providers.add( `OpenAI` )
    if( claude && ( auth.claude?.claudeAiOauth?.accessToken || env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY ) ) providers.add( `Anthropic` )
    if( agy && ( auth.antigravity?.access_token || auth.antigravity?.refresh_token || env.GEMINI_API_KEY ) ) providers.add( `Google` )
    if( opencode ) {
        for( const [ provider, credential ] of Object.entries( auth.opencode || {} ) ) {
            if( ( credential?.key || credential?.access ) && creator_names[provider] ) providers.add( creator_names[provider] )
        }
        for( const [ provider, key ] of Object.entries( {
            openai: env.OPENAI_API_KEY, anthropic: env.ANTHROPIC_API_KEY,
            google: env.GOOGLE_GENERATIVE_AI_API_KEY, deepseek: env.DEEPSEEK_API_KEY,
            mistral: env.MISTRAL_API_KEY, cohere: env.COHERE_API_KEY,
        } ) ) {
            if( key ) providers.add( creator_names[provider] )
        }
    }
    return providers
}
