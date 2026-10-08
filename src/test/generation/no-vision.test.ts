import { describe, expect, it, vi } from 'vitest'

import { lookAtScreen } from '@/lib/generation/frames'
import type { GenerationSession } from '@/lib/generation/session'
import type { RecordingData } from '@/types/domain'

const recording: RecordingData = {
  blocks: [{ speaker: 'speaker_0', start: 0, end: 5, text: 'Olha esse slide.' }],
  speakers: [{ id: 'speaker_0', name: 'Falante 2', suggested: false }],
  marks: [],
}

describe('without a vision model', () => {
  it('the note is made without frames and says why', async () => {
    const session = { chat: vi.fn() } as unknown as GenerationSession
    const grab = vi.fn()
    const see = vi.fn()
    const seen = await lookAtScreen(recording, new Blob(['v'], { type: 'video/webm' }), null, session, { grab, see })
    expect(grab).not.toHaveBeenCalled()
    expect(see).not.toHaveBeenCalled()
    expect(seen.frames).toBeUndefined()
    expect(seen.warning).toMatch(/Modelo de visão/)
    expect(seen.blocks).toEqual(recording.blocks)
  })

  it('a recording without video does not warn anything', async () => {
    const seen = await lookAtScreen(recording, null, null, { chat: vi.fn() } as unknown as GenerationSession)
    expect(seen).toBe(recording)
  })
})

describe('the vision model setting', () => {
  it('is off until a provider and a model are chosen, and uses the key saved for that provider', async () => {
    const { visionSettingsOf } = await import('@/lib/generation/frames')
    const { defaultSettings } = await import('@/lib/defaults')
    const settings = defaultSettings()
    expect(visionSettingsOf(settings)).toBeNull()
    expect(visionSettingsOf({ ...settings, vision: { provider: 'openai', model: 'gpt-4.1-mini' } })).toBeNull()
    expect(visionSettingsOf({ ...settings, vision: { provider: 'openai', model: 'gpt-4.1-mini' }, aiCredentials: { openai: { apiKey: 'sk-1', model: '', baseUrl: '' } } })).toEqual({ provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'sk-1', baseUrl: '' })
  })
})
