import { docker_command_prefix } from '../docker/run.js'
import { run } from '../utils/exec.js'
import { READ_COMPLETION } from '../web_bridge/completion.js'

/**
 * Read authoritative root identity captured by the native launch hooks.
 * read() returns a cached record without blocking; refresh() awaits one read.
 * Missing/unreadable identity is never replaced with a guessed transcript.
 * @param {Object} session - Stored launch metadata
 * @param {Object} [options] - Async command runner and millisecond clock seams
 * @returns {{read: Function, refresh: Function, close: Function}} Identity reader
 */
export const create_identity_reader = ( session, { run_command = run, now_fn = Date.now } = {} ) => {

    const capture = session?.completion_capture
    const enabled = /^[a-f0-9-]{36}$/.test( capture?.launch_id || `` )
        && capture.file === `/tmp/.babysit-completion-${ capture.launch_id }/message.json`
        && /^[a-f0-9]{12,64}$/.test( session.container_id || `` )
    const [ command, ...prefix ] = docker_command_prefix()
    const controller = new AbortController()
    let latest = null
    let pending = null
    let closed = false
    let next_poll_at = 0

    const poll = async () => {
        try {
            const output = await run_command( command, [
                ...prefix, `exec`, session.container_id, `node`, `-e`, READ_COMPLETION,
                capture.file.replace( `/message.json`, `/identity.json` ), `4096`,
            ], { signal: controller.signal }, 5_000 )
            if( closed || output.length > 5_464 ) return latest
            const bytes = Buffer.from( output, `base64` )
            if( bytes.length > 4096 ) return latest
            const record = JSON.parse( bytes.toString( `utf8` ) )
            if( record?.version !== 1 || record.launch_id !== capture.launch_id || record.agent !== session.agent ) return latest
            if( typeof record.session_id !== `string` || !/^[a-zA-Z0-9_-]{1,256}$/.test( record.session_id ) ) return latest
            if( typeof record.captured_at !== `string` || !Number.isFinite( Date.parse( record.captured_at ) ) ) return latest
            if( latest && Date.parse( record.captured_at ) < Date.parse( latest.captured_at ) ) return latest
            latest = record
        } catch { /* Missing identity is normal before a root session exists. */ }
        return latest
    }

    const refresh = () => {
        if( closed || !enabled ) return Promise.resolve( latest )
        if( !pending ) {
            next_poll_at = now_fn() + 2_000
            pending = poll().finally( () => {
                pending = null
            } )
        }
        return pending
    }

    return {
        read() {
            if( now_fn() >= next_poll_at ) refresh()
            return latest
        },
        refresh,
        close() {
            closed = true
            controller.abort()
        },
    }

}
