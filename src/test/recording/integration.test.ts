import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { INTEGRATION_DOWNLOADS, IntegrationLink, integrationOsOf, useIntegrationStore } from '@/lib/recording/integration'
import { FakeSocket, installIntegration } from '@/test/recording/integration-fakes'

const LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36'

beforeEach(() => useIntegrationStore.setState({ status: 'unknown', hello: null }))
afterEach(() => vi.unstubAllGlobals())

describe('integration download', () => {
  it('offers the file for Linux or Windows and nothing on other systems', () => {
    expect(integrationOsOf(LINUX)).toBe('linux')
    expect(integrationOsOf(WINDOWS)).toBe('windows')
    expect(integrationOsOf(MAC)).toBeNull()
    expect(integrationOsOf(ANDROID)).toBeNull()
    expect(INTEGRATION_DOWNLOADS.linux).toMatch(/releases\/download\/desktop-latest\/study-helper-audio-x86_64\.AppImage$/)
    expect(INTEGRATION_DOWNLOADS.windows).toMatch(/releases\/download\/desktop-latest\/study-helper-audio\.exe$/)
  })
})

describe('integration connection', () => {
  it('says it is missing when nothing answers on this computer', async () => {
    installIntegration({ available: false })
    expect(await useIntegrationStore.getState().check()).toBe(false)
    expect(useIntegrationStore.getState().status).toBe('missing')
    expect(FakeSocket.instances[0].url).toBe('ws://127.0.0.1:47811')
  })

  it('says it is connected, with the version, and a new check does not flip it back to searching', async () => {
    installIntegration({ available: true })
    await useIntegrationStore.getState().check()
    expect(useIntegrationStore.getState()).toMatchObject({ status: 'connected', hello: { version: '0.1.0', os: 'linux' } })
    const seen: string[] = []
    const stop = useIntegrationStore.subscribe(state => seen.push(state.status))
    await useIntegrationStore.getState().check()
    stop()
    expect(seen).not.toContain('checking')
  })

  it('lists the open windows and hands each audio frame to its channel', async () => {
    installIntegration({ available: true, windows: [{ id: 'x11:9', title: 'SoWork - Google Chrome', app: 'Google-chrome', pid: 77 }] })
    const link = (await IntegrationLink.open())!
    expect(await link.sources()).toEqual({ type: 'sources', listing: 'windows', windows: [{ id: 'x11:9', title: 'SoWork - Google Chrome', app: 'Google-chrome', pid: 77 }] })
    const frames: [number, number[]][] = []
    link.onFrame = (channel, samples) => frames.push([channel, Array.from(samples)])
    FakeSocket.instances[0].frame(1, [0.5, -0.25])
    FakeSocket.instances[0].frame(0, [0.125])
    expect(frames).toEqual([
      [1, [0.5, -0.25]],
      [0, [0.125]],
    ])
  })

  it('passes on the reason when the integration refuses to start', async () => {
    installIntegration({ available: true })
    FakeSocket.replies.start = { type: 'error', message: 'O som do computador recusou a conexão.' }
    const link = (await IntegrationLink.open())!
    await expect(link.start({ kind: 'window', pid: 5 })).rejects.toThrow('O som do computador recusou a conexão.')
    expect(FakeSocket.instances[0].sent.at(-1)).toEqual({ type: 'start', source: { kind: 'window', pid: 5 }, microphone: null })
  })
})
