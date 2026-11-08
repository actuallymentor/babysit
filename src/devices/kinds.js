import { adb_mode, ios_mode, mac_mode } from '../system_prompt/index.js'

/**
 * Every kind of device a session can drive. The `--devices` switch, the launch
 * menu, yaml keys, audit questions, the mode descriptor, the system prompt and
 * the container env all derive from this one list: a new kind adds a row here,
 * its in-container command, and its Docker flags in docker/run.js.
 *
 * Order is the flag/yaml/menu order. `prompt` is appended to the system prompt
 * when the kind is on; `container_env` is set for the session so in-container
 * tools can tell the kind is enabled.
 */
export const DEVICE_KINDS = [
    {
        name: `adb`, label: `ADB`, note: `Android device access (adb)`,
        summary: `Android adb with a key shared by every session (network devices only)`,
        question: `Give the session Android device access (--adb)?`,
        prompt: adb_mode,
    },
    {
        name: `ios`, label: `iOS`, note: `iPhone access (ios, iOS 16 and older)`,
        summary: `iOS 16 devices via WebDriverAgent, pairing shared by every session (network only)`,
        question: `Give the session iPhone access (--ios)?`,
        prompt: ios_mode,
    },
    {
        name: `mac`, label: `Mac`, note: `remote Macs (mac)`,
        summary: `Remote Macs (SSH + Screen Sharing); credentials from babysit mac add reach only these sessions`,
        question: `Give the session remote Mac access (--mac)?`,
        prompt: mac_mode,
    },
]

export const DEVICE_NAMES = DEVICE_KINDS.map( kind => kind.name )

/** Whether every device kind is on: the one `--devices` switch. */
export const all_devices = flags => DEVICE_NAMES.every( name => flags?.[ name ] )

/** Every kind set to one value, e.g. all off when --devices stands for them. */
export const every_device = value => Object.fromEntries( DEVICE_NAMES.map( name => [ name, value ] ) )

/** The kinds named in a flag/mode object, as a plain `{ adb, ios, mac }` copy. */
export const pick_devices = flags => Object.fromEntries( DEVICE_NAMES.map( name => [ name, flags?.[ name ] ] ) )
