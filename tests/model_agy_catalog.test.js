import { expect, it } from 'bun:test'
import { parse_agy_models } from '../src/docker/assets/effort/agy-catalog.mjs'

it( `keeps native model IDs, labels and per-family effort capabilities`, () => {
    const catalog = parse_agy_models( `Fetching available models...\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\r\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n` )
    expect( catalog ).toEqual( [
        { id: `gemini-3.8-flash-medium`, name: `Gemini 3.8 Flash (Medium)`, family: `gemini-3.8-flash`, effort: `medium` },
        { id: `gemini-3.1-pro-low`, name: `Gemini 3.1 Pro (Low)`, family: `gemini-3.1-pro`, effort: `low` },
        { id: `gemini-3.1-pro-high`, name: `Gemini 3.1 Pro (High)`, family: `gemini-3.1-pro`, effort: `high` },
    ] )
} )
