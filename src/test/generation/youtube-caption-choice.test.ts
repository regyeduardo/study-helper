import { afterEach, describe, expect, it, vi } from 'vitest'

import { collapseRepeats, fetchYoutubeTranscriptController } from '@/controllers/sources.controller'

const header = (language: string, others: string) =>
  `# Transcript: Palestra\n\nSource video: https://www.youtube.com/watch?v=HsQx02JdZ2Q\nLanguage: ${language} · Duration: 16:18 · Words: 10\nOther available languages: ${others}\nTo request a specific language: https://youtube-transcript.ai/transcript/HsQx02JdZ2Q.txt?lang=LANG_CODE\n\n## Transcript\n`

const TRACKS: Record<string, string> = {
  '': header('ar', 'a-pt (pt) [auto], pt-BR (pt-BR)') + '[0:09] نص عربي',
  pt: header('pt (auto-generated)', 'en (en), pt-BR (pt-BR)') + '[0:09] haverá quem diga que haverá quem diga que felicidade é você ter',
  'pt-BR': header('pt-BR', 'en (en), a-pt (pt) [auto]') + '[0:09] Haverá quem diga que felicidade é você ter o que você quer.',
}

function stubService(tracks: Record<string, string>) {
  const asked: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.host.includes('youtube-transcript.ai')) {
      const lang = url.searchParams.get('lang') ?? ''
      asked.push(lang)
      return new Response(tracks[lang] ?? '', { status: tracks[lang] ? 200 : 404 })
    }
    return new Response(JSON.stringify({ title: 'Palestra' }), { status: 200 })
  }))
  return asked
}

afterEach(() => vi.unstubAllGlobals())

describe('legenda do YouTube: a do idioma falado, feita por gente quando existe', () => {
  it('sem idioma escolhido não aceita a tradução que o serviço devolve e busca a humana do idioma falado', async () => {
    const asked = stubService(TRACKS)
    const { content } = await fetchYoutubeTranscriptController('https://www.youtube.com/watch?v=HsQx02JdZ2Q', '')
    expect(asked).toEqual(['', 'pt-BR'])
    expect(content).toContain('Haverá quem diga que felicidade é você ter o que você quer.')
    expect(content).not.toContain('Other available languages')
  })

  it('com "pt" escolhido troca a automática pela humana pt-BR', async () => {
    const asked = stubService(TRACKS)
    await fetchYoutubeTranscriptController('https://youtu.be/HsQx02JdZ2Q', 'pt')
    expect(asked).toEqual(['pt', 'pt-BR'])
  })

  it('só com a automática, tira as repetições da legenda rolante', async () => {
    stubService({ pt: header('pt (auto-generated)', 'en (en)') + '[0:09] felicidade é você ter o que você felicidade é você ter o que você felicidade é você ter o que você quer' })
    const { content } = await fetchYoutubeTranscriptController('https://youtu.be/HsQx02JdZ2Q', 'pt')
    expect(content).toBe('[0:09] felicidade é você ter o que você quer')
  })
})

describe('collapseRepeats', () => {
  it('junta trechos repetidos em seguida e mantém o resto', () => {
    expect(collapseRepeats('a b c a b c d')).toBe('a b c d')
    expect(collapseRepeats('muito muito bom')).toBe('muito muito bom')
  })
})
