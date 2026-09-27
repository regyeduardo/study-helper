import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { File as NodeFile } from 'node:buffer'

import { HOSTS, isHostOnlineController, uploadToGofileController, uploadToLitterboxController } from '@/controllers/hosting.controller'

const live = process.env.LIVE === '1'
const CONTENT = 'study-helper test\n\n\n'

async function useNativeFormData(): Promise<void> {
  const native = (await new Response('probe=1', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).formData()).constructor
  vi.stubGlobal('FormData', native)
  vi.stubGlobal('File', NodeFile)
}

function tinyFile(): File {
  return new NodeFile([CONTENT], 'study-helper-test.txt', { type: 'text/plain' }) as unknown as File
}

describe.skipIf(!live)('live upload', () => {
  beforeAll(async () => {
    await useNativeFormData()
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('uploads a tiny file to Litterbox for 1 hour', async () => {
    const litterbox = HOSTS.find(host => host.id === 'litterbox')!
    const online = await isHostOnlineController(litterbox)
    const hosted = await uploadToLitterboxController(tinyFile(), '1h')
    console.log(`LIVE litterbox online=${online} url=${hosted.url} expiresAt=${hosted.expiresAt}`)
    expect(hosted.url).toMatch(/^https:\/\/litter\.catbox\.moe\//)
    const downloaded = await fetch(hosted.url)
    console.log(`LIVE litterbox download status=${downloaded.status}`)
    expect(await downloaded.text()).toBe(CONTENT)
  }, 60_000)

  it('uploads a tiny file to Gofile', async () => {
    const gofile = HOSTS.find(host => host.id === 'gofile')!
    const online = await isHostOnlineController(gofile)
    const hosted = await uploadToGofileController(tinyFile())
    console.log(`LIVE gofile online=${online} url=${hosted.url} expiresAt=${hosted.expiresAt}`)
    expect(hosted.url).toMatch(/^https:\/\/gofile\.io\/d\//)
  }, 60_000)
})
