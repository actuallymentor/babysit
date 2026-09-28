import { describe, expect, test } from 'bun:test'
import { terminal_control } from '../src/control/terminal.js'

const callbacks = ( first, transition ) => {
    let screen = first
    const sent = []
    return {
        capture: async () => screen,
        send_text: async text => {
            sent.push( [ `text`, text ] )
            screen = transition( screen, `text`, text )
        },
        send_keys: async ( ...keys ) => {
            sent.push( [ `keys`, ...keys ] )
            screen = transition( screen, `keys`, ...keys )
        },
        sent,
    }
}

const claude_ready = `Claude Code v2.1.278\n● high · /effort\n────\n❯\u00a0Try "fix typecheck errors"\n────\nmanual mode on`
const agy_ready = `Antigravity CLI 1.2.9\n────────────────\n>\n────────────────\n? for shortcuts   Gemini 3.1 Pro · high`

// Claude Code 2.1.283's picker as captured live: a ten-row window with ↑/↓
// scroll hints that wraps at both ends, and an update-only final row.
const claude_catalog = [
    [ `Default (recommended) ✔`, `Opus 5.5 · Best for everyday, complex tasks` ], [ `Opus 5.5`, `For complex work and everyday tasks` ],
    [ `Fable 5.1`, `For your toughest challenges` ], [ `Haiku 4.5`, `Fastest for quick answers` ], [ `Sonnet 5`, `Efficient for routine tasks` ],
    [ `Opus 5`, `Best for everyday, complex tasks` ], [ `Fable 5`, `Most capable for your hardest and longest-running tasks` ],
    [ `Opus 4.8`, `Best for everyday, complex tasks` ], [ `Opus 4.7`, `Best for everyday, complex tasks` ], [ `Opus 4.6`, `Best for everyday, complex tasks` ],
    [ `Sonnet 4.6`, `Efficient for routine tasks` ], [ `Sonnet 5.5`, `Update Claude Code to use this model` ],
]
const claude_picker_screen = ( cursor, top ) => {
    const rows = claude_catalog.slice( top, top + 10 ).map( ( [ alias, note ], offset ) => {
        const index = top + offset
        const hint = index === cursor ? `❯` : offset === 0 && top > 0 ? `↑` : offset === 9 && index < claude_catalog.length - 1 ? `↓` : ` `
        return `   ${ hint } ${ `${ index + 1 }.`.padEnd( 3 ) } ${ alias.padEnd( 24 ) } ${ note }`
    } )
    const footer = cursor === claude_catalog.length - 1 ? `   Esc to cancel` : `   ◐ Medium effort (default) ←/→ to adjust\n   Enter to set as default · s to use this session only · Esc to cancel`
    return `${ claude_ready }\n   Select model\n   Switch between Claude models. Your pick becomes the default for new sessions.\n${ rows.join( `\n` ) }\n      … +2 models\n${ footer }`
}

// A stateful live-picker double: arrows wrap and scroll, `s` applies the row.
const claude_live = ( { busy = false } = {} ) => {
    let screen = claude_ready
    let cursor = 0
    let top = 0
    const sent = []
    const render = () => {
        screen = claude_picker_screen( cursor, top )
    }
    const move = delta => {
        cursor = ( cursor + delta + claude_catalog.length ) % claude_catalog.length
        top = Math.min( Math.max( top, cursor - 9 ), cursor )
        render()
    }
    return {
        sent,
        get screen() {
            return screen
        },
        capture: async () => screen,
        send_text: async text => {
            sent.push( [ `text`, text ] )
            // Slash autocomplete quotes a skill description before Enter lands.
            screen = `${ claude_ready }\n  /shapeshift   Select model and reasoning effort for planning (user)\n❯ /model`
            setTimeout( render, 30 )
        },
        send_keys: async key => {
            sent.push( [ `keys`, key ] )
            if( key === `Up` ) move( -1 )
            if( key === `Down` ) move( 1 )
            if( key === `Escape` ) screen = claude_ready
            if( key === `s` && cursor < claude_catalog.length - 1 ) {
                const alias = claude_catalog[ cursor ][ 0 ].replace( / ✔$/, `` )
                // Mid-turn Claude skips the transcript echo and shows a notice.
                screen = busy
                    ? `${ claude_ready }\n${ ` `.repeat( 60 ) }Set model to ${ alias } for this session only`
                    : `${ claude_ready }\n❯ /model\n  ⎿  Set model to ${ alias } for this session only`
            }
        },
    }
}

describe( `native terminal controls`, () => {

    test( `leaves a Claude draft untouched`, async () => {
        const io = callbacks( claude_ready.replace( `Try "fix typecheck errors"`, `first line\nsecond line` ), () => `` )
        await expect( terminal_control( { agent: `claude`, operation: `effort`, value: `low`, ...io } ) ).rejects.toMatchObject( { code: `CONTROL_PENDING` } )
        expect( io.sent ).toEqual( [] )
    } )

    test( `lists Claude's current native model choices and closes its own picker`, async () => {
        const picker = `${ claude_ready }\nSelect model\n❯ 1. Sonnet  Sonnet 5\n  2. Opus (1M context)  Opus 5\n  3. Opus 5.5 (disabled)  Update required`
        const io = callbacks( claude_ready, ( _, action, key ) => action === `text` ? picker : key === `Escape` ? claude_ready : picker )
        const result = await terminal_control( { agent: `claude`, operation: `model`, ...io } )
        expect( result.models.map( model => model.id ) ).toEqual( [ `sonnet`, `opus[1m]`, null ] )
        expect( io.sent[ 0 ] ).toEqual( [ `text`, `/model` ] )
        expect( io.sent.at( -1 ) ).toEqual( [ `keys`, `Escape` ] )
    } )

    test( `treats Claude's dim suggested prompt as empty but a typed draft as a draft`, async () => {
        const suggestion = `${ claude_ready }\n❯\u00a0\x1b[2mRun it in the background instead\x1b[0m\n────`
        const io = claude_live()
        const result = await terminal_control( { agent: `claude`, operation: `model`, capture_styled: async () => suggestion, ...io } )
        expect( result.models ).toHaveLength( 12 )

        const typed = claude_live()
        const draft = async () => `${ claude_ready }\n❯\u00a0\x1b[39mRun it in the background instead\n────`
        await expect( terminal_control( { agent: `claude`, operation: `model`, capture_styled: draft, ...typed } ) ).rejects.toMatchObject( { code: `CONTROL_PENDING` } )
        expect( typed.sent ).toEqual( [] )
    } )

    test( `waits past slash autocomplete and lists a wrapping Claude picker in one cycle`, async () => {
        const io = claude_live()
        const result = await terminal_control( { agent: `claude`, operation: `model`, ...io } )
        expect( result.models ).toHaveLength( 12 )
        expect( result.models.map( model => model.id ) ).toEqual( [ `default`, `opus-5.5`, `fable-5.1`, `haiku-4.5`, `sonnet-5`, `opus-5`, `fable-5`, `opus-4.8`, `opus-4.7`, `opus-4.6`, `sonnet-4.6`, null ] )
        expect( io.sent.filter( ( [ , key ] ) => key === `Up` || key === `Down` ) ).toHaveLength( 12 )
        expect( io.sent.at( -1 ) ).toEqual( [ `keys`, `Escape` ] )
        expect( io.screen ).toBe( claude_ready )
    } )

    test( `switches Claude by API model ID mid-turn and reads its notice`, async () => {
        const io = claude_live( { busy: true } )
        const result = await terminal_control( { agent: `claude`, operation: `model`, value: `claude-fable-5-1`, busy: true, ...io } )
        expect( result.applied ).toBe( `Fable 5.1` )
        expect( io.sent.at( -1 ) ).toEqual( [ `keys`, `s` ] )
    } )

    test( `a lingering Opus 5.5 notice does not confirm Opus 5`, async () => {
        const io = claude_live( { busy: true } )
        const stale = `${ claude_ready }\n${ ` `.repeat( 60 ) }Set model to Opus 5.5 for this session only`
        let pressed = false
        const capture = async () => pressed ? stale : io.capture()
        const send_keys = async key => {
            await io.send_keys( key )
            pressed ||= key === `s`
        }
        await expect( terminal_control( { agent: `claude`, operation: `model`, value: `opus-5`, busy: true, timeout_ms: 300, send_text: io.send_text, capture, send_keys } ) ).rejects.toThrow( `timed out` )
        expect( io.sent.at( -1 ) ).toEqual( [ `keys`, `s` ] )
    } )

    test( `rejects an update-only Claude model and closes the picker`, async () => {
        const io = claude_live()
        await expect( terminal_control( { agent: `claude`, operation: `model`, value: `sonnet-5.5`, ...io } ) ).rejects.toMatchObject( { code: `CONTROL_UNSUPPORTED` } )
        expect( io.sent.filter( ( [ , key ] ) => key === `Escape` ) ).toHaveLength( 1 )
        expect( io.screen ).toBe( claude_ready )
    } )

    test( `names ambiguous Claude family matches`, async () => {
        const io = claude_live()
        await expect( terminal_control( { agent: `claude`, operation: `model`, value: `fable`, ...io } ) ).rejects.toThrow( `Matches: Fable 5.1, Fable 5.` )
        expect( io.screen ).toBe( claude_ready )
    } )

    test( `selects Claude effort for this session and reads native confirmation`, async () => {
        const picker = `${ claude_ready }\nEffort\nlow     medium     high     xhigh      max`
        const confirmed = `${ claude_ready }\n❯ /effort\n  ⎿  Set effort level to low (this session only): Quick implementation`
        const io = callbacks( claude_ready, ( _, action, key ) => action === `text` ? picker : key === `s` ? confirmed : picker )
        const result = await terminal_control( { agent: `claude`, operation: `effort`, value: `low`, ...io } )
        expect( result.applied ).toBe( `low` )
        expect( io.sent.at( -1 ) ).toEqual( [ `keys`, `s` ] )
    } )

    test( `accepts a model ID emitted by Claude's picker`, async () => {
        const picker = `${ claude_ready }\nSelect model\n❯ 1. Default (recommended)  Sonnet 5\n  2. Opus (1M context)  Opus 5`
        const confirmed = `${ claude_ready }\n❯ /model\n  ⎿  Kept model as Default (this session only)`
        const io = callbacks( claude_ready, ( _, action, key ) => action === `text` ? picker : key === `s` ? confirmed : picker )
        const result = await terminal_control( { agent: `claude`, operation: `model`, value: `default`, ...io } )
        expect( result.applied ).toBe( `Default (recommended)` )
        expect( io.sent.at( -1 ) ).toEqual( [ `keys`, `s` ] )
    } )

    test( `dismisses an owned Claude picker after guarded capture expires`, async () => {
        const picker = `${ claude_ready }\nSelect model\n❯ 1. Sonnet  Sonnet 5\nEnter to set as default · s to use this session only · Esc to cancel`
        let screen = claude_ready
        let expired = false
        const sent = []
        const capture = async () => {
            if( expired ) throw new Error( `deadline expired` )
            return screen
        }
        const send_text = async text => {
            sent.push( text )
            screen = picker
            expired = true
        }
        const send_keys = async key => {
            sent.push( key )
        }
        const dismiss = async predicate => {
            if( predicate( screen ) ) {
                sent.push( `unguarded Escape` )
                screen = claude_ready
            }
        }
        await expect( terminal_control( { agent: `claude`, operation: `model`, capture, send_text, send_keys, dismiss } ) ).rejects.toThrow( `deadline expired` )
        expect( sent ).toEqual( [ `/model`, `unguarded Escape` ] )
        expect( screen ).toBe( claude_ready )
    } )

    test( `sends one Escape for an unsupported Claude model despite stale rendering`, async () => {
        const picker = `${ claude_ready }\nSelect model\n❯ 1. Sonnet  Sonnet 5\nEnter to set as default · s to use this session only · Esc to cancel`
        const io = callbacks( claude_ready, () => picker )
        await expect( terminal_control( { agent: `claude`, operation: `model`, value: `unavailable-model`, ...io } ) ).rejects.toMatchObject( { code: `CONTROL_UNSUPPORTED` } )
        expect( io.sent.filter( event => event[ 1 ] === `Escape` ) ).toEqual( [ [ `keys`, `Escape` ] ] )
    } )

    test( `dismisses nested Claude effort picker after model fallback expires`, async () => {
        const model_picker = `${ claude_ready }\nSelect model\n❯ 1. Haiku  Haiku 4.5\nEffort not supported for Haiku\nEnter to set as default · s to use this session only · Esc to cancel`
        const model_confirmed = `${ claude_ready }\n❯ /model\n  ⎿  Set model to Haiku 4.5 for this session only`
        const effort_picker = `${ model_confirmed }\nEffort\nlow     medium     high     xhigh      max\n←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel`
        let screen = claude_ready
        let expired = false
        const sent = []
        const capture = async () => {
            if( expired ) throw new Error( `deadline expired` )
            return screen
        }
        const send_text = async text => {
            sent.push( text )
            if( text === `/model` ) screen = model_picker
            else {
                screen = effort_picker
                expired = true
            }
        }
        const send_keys = async key => {
            sent.push( key )
            if( key === `s` ) screen = model_confirmed
        }
        const dismiss = async predicate => {
            if( predicate( screen ) ) {
                sent.push( `unguarded Escape` )
                screen = claude_ready
            }
        }
        await expect( terminal_control( { agent: `claude`, operation: `model`, value: `haiku`, capture, send_text, send_keys, dismiss } ) ).rejects.toThrow( `deadline expired` )
        expect( sent.filter( event => event === `unguarded Escape` ) ).toEqual( [ `unguarded Escape` ] )
        expect( sent ).toContain( `/effort` )
        expect( screen ).toBe( claude_ready )
    } )

    test( `does not dismiss historical dialog text after a failed command`, async () => {
        let screen = claude_ready
        let expired = false
        let dismissed = false
        const capture = async () => {
            if( expired ) throw new Error( `deadline expired` )
            return screen
        }
        const send_text = async () => {
            screen = `${ claude_ready }\n❯ Earlier note: Select model is in the manual.`
            expired = true
        }
        const dismiss = async predicate => {
            dismissed = predicate( screen )
        }
        await expect( terminal_control( { agent: `claude`, operation: `model`, capture, send_text, send_keys: async () => {}, dismiss } ) ).rejects.toThrow( `deadline expired` )
        expect( dismissed ).toBe( false )
    } )

    test( `dismisses an OpenCode picker when its guarded cleanup also expires`, async () => {
        const ready = `┃\n┃  Ask anything… "Fix broken tests"\n┃\n┃  Build · GPT-6 Luna OpenRouter\n╹▀▀▀▀▀▀`
        let screen = `${ ready }\nSelect model  esc\nSearch\nRecent\nGPT-6 Luna  OpenRouter\nConnect provider ctrl+a`
        let calls = 0
        let dismissed = false
        const capture = async () => {
            if( ++calls > 2 ) throw new Error( `deadline expired` )
            return calls === 1 ? ready : screen
        }
        const send_text = async () => {}
        const dismiss = async predicate => {
            dismissed = predicate( screen )
            if( dismissed ) screen = ready
        }
        const target = { id: `openrouter/openai/gpt-5.6-luna`, provider_id: `openrouter`, name: `GPT-5.6 Luna`, effort: `default` }
        await expect( terminal_control( { agent: `opencode`, operation: `model`, value: target.id, target, capture, send_text, send_keys: async () => {}, dismiss } ) ).rejects.toThrow( `deadline expired` )
        expect( dismissed ).toBe( true )
        expect( screen ).toBe( ready )
    } )

    test( `uses Antigravity's exact model slug and checks the footer`, async () => {
        const changed = `Antigravity CLI 1.2.9\n> /model\n  ⎿  Model set to Gemini 3.8 Flash (High)\n────────────────\n>\n────────────────\n? for shortcuts   Gemini 3.8 Flash · high`
        const io = callbacks( agy_ready, ( _, action ) => action === `text` ? changed : agy_ready )
        const result = await terminal_control( {
            agent: `antigravity`, operation: `model`, value: `gemini-3.8-flash-high`,
            target: { id: `gemini-3.8-flash-high`, name: `Gemini 3.8 Flash (High)`, effort: `high` }, ...io,
        } )
        expect( result.applied ).toBe( `gemini-3.8-flash-high` )
        expect( io.sent ).toEqual( [ [ `text`, `/model gemini-3.8-flash-high` ] ] )
    } )

    test( `rejects unavailable Antigravity effort without changing the model`, async () => {
        const picker = `${ agy_ready }\nSet Effort\nlow                   high\nKeyboard: ←/→ Effort`
        const io = callbacks( agy_ready, ( _, action ) => action === `text` ? picker : agy_ready )
        await expect( terminal_control( { agent: `antigravity`, operation: `effort`, value: `medium`, ...io } ) ).rejects.toMatchObject( { code: `CONTROL_UNSUPPORTED` } )
        expect( io.sent ).toEqual( [ [ `text`, `/effort` ], [ `keys`, `Escape` ] ] )
    } )

    test( `rejects OpenCode when its composer contains a draft`, async () => {
        const screen = `┃\n┃  unfinished instruction\n┃\n┃  Build · GPT-6 Luna OpenRouter\n╹▀▀▀▀▀▀`
        const io = callbacks( screen, () => `` )
        await expect( terminal_control( { agent: `opencode`, operation: `model`, value: `openrouter/openai/gpt-6-luna`, ...io } ) ).rejects.toMatchObject( { code: `CONTROL_PENDING` } )
        expect( io.sent ).toEqual( [] )
    } )

    test( `switches OpenCode model and selects a compatible variant`, async () => {
        const ready = `┃\n┃  Ask anything… "Fix broken tests"\n┃\n┃  Build · GPT-6 Luna OpenRouter\n╹▀▀▀▀▀▀`
        const picker = `${ ready }\nSelect model  esc\nSearch\nRecent\nGPT-6 Luna  OpenRouter\nConnect provider ctrl+a`
        const filtered = `${ ready }\nSelect model  esc\nGPT-5.6 Luna\nGPT-5.6 Luna  OpenRouter\nGPT-5.6 Luna Pro  OpenRouter\nConnect provider ctrl+a`
        const variants = `${ ready }\nSelect variant  esc\nSearch\nDefault\nnone\nlow\nmedium\nhigh`
        const filtered_variant = `${ ready }\nSelect variant  esc\nhigh\nhigh`
        const changed = ready.replace( `GPT-6 Luna OpenRouter`, `GPT-5.6 Luna OpenRouter · high` )
        const io = callbacks( ready, ( screen, action, key, query ) => {
            if( action === `text` ) return picker
            if( key === `-l` && query === `GPT-5.6 Luna` ) return filtered
            if( key === `Enter` && screen === filtered ) return variants
            if( key === `-l` && query === `high` ) return filtered_variant
            if( key === `Enter` && screen === filtered_variant ) return changed
            return screen
        } )
        const target = { id: `openrouter/openai/gpt-5.6-luna`, provider_id: `openrouter`, name: `GPT-5.6 Luna`, efforts: [ `low`, `medium`, `high` ], effort: `high` }
        const result = await terminal_control( { agent: `opencode`, operation: `model`, value: target.id, target, ...io } )
        expect( result.applied ).toBe( target.id )
        expect( io.sent ).toEqual( [ [ `text`, `/models` ], [ `keys`, `-l`, `GPT-5.6 Luna` ], [ `keys`, `Enter` ], [ `keys`, `-l`, `high` ], [ `keys`, `Enter` ] ] )
    } )

} )
