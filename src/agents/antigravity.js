/** Antigravity CLI adapter. Flags verified against agy 1.2.1. */
export const antigravity = {

    name: `antigravity`,
    bin: `agy`,

    credentials: {
        darwin: {
            keychain_service: `gemini`,
            keychain_account: `antigravity`,
            fallback_file: `~/.gemini/antigravity-cli/antigravity-oauth-token`,
            env_key: `GEMINI_API_KEY`,
        },
        linux: {
            secret_service: { service: `gemini`, account: `antigravity` },
            file: `~/.gemini/antigravity-cli/antigravity-oauth-token`,
            env_key: `GEMINI_API_KEY`,
        },
    },

    // Antigravity resolves its native state from the user's home directory.
    home: { env_var: `HOME`, dir: `/home/node` },

    container_paths: {
        creds: `/home/node/.gemini/antigravity-cli/antigravity-oauth-token`,
        user_globals_file: `/home/node/.gemini/GEMINI.md`,
    },

    flags: {
        skip_permissions: () => `--dangerously-skip-permissions`,
        resume: id => [ `--conversation`, id ],
        resume_latest: () => [ `--continue` ],
        model: model => [ `--model`, model ],
        effort: effort => [ `--effort`, effort ],
    },

    auth_check: {
        args: prompt => [ `--print`, prompt ],
    },

    // Let the user's account and native CLI choose an available model.
    defaults: {},

    // The same '>' glyph appears in onboarding and workspace trust pickers.
    // Only the idle composer has an empty prompt plus the shortcuts footer.
    initial_prompt_ready: output => /^\s*>\s*$/m.test( output ) && /\? for shortcuts/.test( output ),

    session_id_pattern: /(?:agy\s+--conversation\s+|conversation(?:\s+id)?[:\s]+)([0-9a-f-]{36})/i,

    extra_env: () => ( {} ),

    update: {
        self_update: { cmd: `agy`, args: [ `update` ] },
    },

}
