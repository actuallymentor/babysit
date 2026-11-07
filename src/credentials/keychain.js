import { spawnSync } from 'child_process'

const KEYCHAIN_TIMEOUT_MS = 10_000

// errSecItemNotFound: the only `security` exit that says "no such login".
// A locked keychain or a denied prompt fails differently and proves nothing.
const KEYCHAIN_ITEM_NOT_FOUND = 44

/**
 * The one macOS Keychain reader: no shell, and "no item" kept apart from
 * "could not ask" (locked keychain, denied access, timeout).
 * @param {{ keychain: string, account?: string }} source - Adapter keychain source
 * @param {Object} [options] - Process seam
 * @param {Function} [options.spawn_sync=spawnSync] - Synchronous spawn
 * @returns {{ state: 'present'|'missing'|'unknown', text?: string }} Keychain state
 */
export const read_keychain_item = ( source, { spawn_sync = spawnSync } = {} ) => {

    const args = [
        `find-generic-password`,
        `-s`, source.keychain,
        ...source.account ? [ `-a`, source.account ] : [],
        `-w`,
    ]
    const { status, stdout } = spawn_sync( `security`, args, {
        encoding: `utf-8`,
        stdio: [ `ignore`, `pipe`, `ignore` ],
        timeout: KEYCHAIN_TIMEOUT_MS,
    } ) || {}

    if( status === KEYCHAIN_ITEM_NOT_FOUND ) return { state: `missing` }
    const text = status === 0 ? String( stdout || `` ).trim() : ``
    return text ? { state: `present`, text } : { state: `unknown` }

}
