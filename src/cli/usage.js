import { acquire_host_auth_lease } from '../agents/auth_lease.js'
import { run_usage as run_portable_usage } from '../docker/assets/usage/command.mjs'
import { claude_account_entries } from './claude_accounts.js'

/** Serialize native keyring-backed refresh with host launch authentication. */
export const run_usage = async ( args = [], options = {} ) => {

    if( args.includes( `--help` ) || args.includes( `-h` ) ) return run_portable_usage( args, options )
    const lease = await acquire_host_auth_lease()
    try {
        return await run_portable_usage( args, {
            ...options,
            allow_native_refresh: process.env.BABYSIT_DOCKER !== `1`,
            // Asked for now, so every account is read fresh
            claude_accounts: claude_account_entries( { max_age_ms: 0 } ),
        } )
    } finally {
        lease.release()
    }

}
