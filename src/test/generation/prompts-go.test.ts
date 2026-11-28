import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// T204 (FR-084): the backend in Go asks the AI with the same instructions as the browser: api/internal/prompts/prompts.json is made from
// prompts.data.ts by scripts/prompts-go.py. This test fails when they drift apart (run the script after changing an instruction).

import { PROMPTS } from '@/lib/generation/prompts.data'

describe('as instruções da IA do backend em Go', () => {
  it('são as mesmas do navegador', () => {
    const go = JSON.parse(readFileSync('api/internal/prompts/prompts.json', 'utf8'))
    expect(go).toEqual(JSON.parse(JSON.stringify(PROMPTS)))
  })
})
