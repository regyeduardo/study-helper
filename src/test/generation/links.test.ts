import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanTranscript,
  fetchWebPageController,
  fetchYoutubeTranscriptController,
  fetchYoutubeWithGeminiController,
  isWebUrl,
  SourceError,
  youtubeId,
} from '@/controllers/sources.controller'
import { resolveInput } from '@/lib/generation/inputs'
import { defaultSettings } from '@/lib/defaults'
import { installFetch, jsonResponse } from '@/test/ai/fake-provider'
import type { Settings } from '@/types/domain'
import { File as NodeFile } from 'node:buffer'

const JINA_BODY = 'Title: Página de Teste\n\nURL Source: https://exemplo.com/a\n\nMarkdown Content:\n# Olá\n\nTexto da página.\n'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('link detection', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=10', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://exemplo.com/watch?v=dQw4w9WgXcQ', null],
  ])('youtubeId(%s)', (url, id) => {
    expect(youtubeId(url)).toBe(id)
  })

  it('accepts only http(s) site links', () => {
    expect(isWebUrl('https://exemplo.com/a')).toBe(true)
    expect(isWebUrl('ftp://x.com')).toBe(false)
    expect(isWebUrl('exemplo.com')).toBe(false)
  })
})

describe('site links through Jina Reader', () => {
  it('requests r.jina.ai with the URL appended and plain text Accept', async () => {
    const { calls } = installFetch(() => new Response(JINA_BODY))
    const page = await fetchWebPageController(' https://exemplo.com/a?b=1 ')
    expect(calls[0].url).toBe('https://r.jina.ai/https://exemplo.com/a?b=1')
    expect(calls[0].headers.Accept).toBe('text/plain')
    expect(page).toEqual({ title: 'Página de Teste', content: '# Olá\n\nTexto da página.' })
  })

  it('uses the URL as title and the whole body when Jina headers are missing', async () => {
    installFetch(() => new Response('só texto'))
    expect(await fetchWebPageController('https://exemplo.com')).toEqual({ title: 'https://exemplo.com', content: 'só texto' })
  })

  it('explains the per-minute limit on 429', async () => {
    installFetch(() => new Response('', { status: 429 }))
    await expect(fetchWebPageController('https://exemplo.com')).rejects.toThrow('O leitor de sites (Jina) pediu pra esperar: o limite grátis por minuto acabou.')
  })

  it('reports other statuses, empty pages and network failures', async () => {
    installFetch(() => new Response('', { status: 451 }))
    await expect(fetchWebPageController('https://exemplo.com')).rejects.toThrow('O site não pôde ser lido (451).')
    installFetch(() => new Response('Title: x\nMarkdown Content:\n   '))
    await expect(fetchWebPageController('https://exemplo.com')).rejects.toThrow('O site não tem texto que dê pra ler.')
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
    await expect(fetchWebPageController('https://exemplo.com')).rejects.toBeInstanceOf(SourceError)
  })
})

describe('YouTube through youtube-transcript.ai', () => {
  it('fetches the .txt transcript with language, deduplicates lines and reads the oEmbed title', async () => {
    const { calls } = installFetch(request => {
      if (request.url.startsWith('https://youtube-transcript.ai/')) return new Response('Olá pessoal\n\nolá   PESSOAL\nHoje vamos ver\n')
      if (request.url.startsWith('https://www.youtube.com/oembed')) return jsonResponse({ title: 'Aula de Física' })
      return new Response('', { status: 404 })
    })
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5'
    const video = await fetchYoutubeTranscriptController(url, 'pt')
    expect(calls[0].url).toBe('https://youtube-transcript.ai/transcript/dQw4w9WgXcQ.txt?lang=pt')
    expect(calls[1].url).toBe(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`)
    expect(video).toEqual({ title: 'Aula de Física', content: 'Olá pessoal\nHoje vamos ver' })
  })

  it('omits the lang parameter when language is automatic and falls back to noembed then a default title', async () => {
    const { calls } = installFetch(request => (request.url.startsWith('https://youtube-transcript.ai/') ? new Response('fala') : new Response('', { status: 500 })))
    const video = await fetchYoutubeTranscriptController('https://youtu.be/dQw4w9WgXcQ', '')
    expect(calls[0].url).toBe('https://youtube-transcript.ai/transcript/dQw4w9WgXcQ.txt')
    expect(calls[2].url.startsWith('https://noembed.com/embed?url=')).toBe(true)
    expect(video.title).toBe('Vídeo do YouTube')
  })

  it.each([
    [404, 'Esse vídeo não tem legenda que dê pra ler pelo youtube-transcript.ai.'],
    [429, 'O youtube-transcript.ai pediu pra esperar (uso justo). Tente em alguns minutos ou use o Gemini.'],
    [500, 'O youtube-transcript.ai recusou (500).'],
  ])('explains status %i', async (status, message) => {
    installFetch(() => new Response('', { status }))
    await expect(fetchYoutubeTranscriptController('https://youtu.be/dQw4w9WgXcQ', '')).rejects.toThrow(message)
  })

  it('rejects non-YouTube links without fetching', async () => {
    const { calls } = installFetch(() => new Response(''))
    await expect(fetchYoutubeTranscriptController('https://exemplo.com', '')).rejects.toThrow('Esse link não parece ser de um vídeo do YouTube.')
    expect(calls).toHaveLength(0)
  })

  it('cleanTranscript drops blank and repeated lines ignoring case and spacing', () => {
    expect(cleanTranscript(' A b \n\na  B\nc')).toBe('A b\nc')
  })
})

describe('YouTube through Gemini', () => {
  it('posts the video URL as file_data to gemini-flash-latest with the key header', async () => {
    const { calls } = installFetch(request => {
      if (request.url.includes('generativelanguage')) return jsonResponse({ candidates: [{ content: { parts: [{ text: 'Transcrição ' }, { text: 'completa' }] } }] })
      return jsonResponse({ title: 'Vídeo X' })
    })
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    const video = await fetchYoutubeWithGeminiController(url, 'AIza-key')
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers['x-goog-api-key']).toBe('AIza-key')
    const parts = (calls[0].body as { contents: { parts: Record<string, unknown>[] }[] }).contents[0].parts
    expect(parts[0]).toEqual({ file_data: { file_uri: url } })
    expect(String(parts[1].text)).toMatch(/Transcreva/)
    expect(video).toEqual({ title: 'Vídeo X', content: 'Transcrição completa' })
  })

  it('shows the free plan limit on 429', async () => {
    installFetch(() => new Response('', { status: 429 }))
    await expect(fetchYoutubeWithGeminiController('https://youtu.be/dQw4w9WgXcQ', 'k')).rejects.toThrow('O Gemini recusou por limite do plano grátis (8 h de vídeo por dia).')
  })

  it('requires a key and says only public videos work on other refusals', async () => {
    await expect(fetchYoutubeWithGeminiController('https://youtu.be/dQw4w9WgXcQ', '')).rejects.toThrow(/Falta a chave do Gemini/)
    installFetch(() => new Response('', { status: 400 }))
    await expect(fetchYoutubeWithGeminiController('https://youtu.be/dQw4w9WgXcQ', 'k')).rejects.toThrow('O Gemini recusou o vídeo (400). Só vídeo público funciona.')
  })
})

describe('resolveInput for links', () => {
  const progress = vi.fn()

  function withReader(reader: Settings['youtube']['reader']): Settings {
    const settings = defaultSettings()
    return { ...settings, youtube: { reader, geminiApiKey: 'gk' }, transcription: { ...settings.transcription, language: 'en' } }
  }

  it('site link becomes url origin with name and link back', async () => {
    installFetch(() => new Response(JINA_BODY))
    const resolved = await resolveInput({ kind: 'link', url: 'https://exemplo.com/a' }, defaultSettings(), '', progress)
    expect(resolved.content).toBe('# Página de Teste\n\n# Olá\n\nTexto da página.')
    expect(resolved.title).toBe('Página de Teste')
    expect(resolved.description).toBe('https://exemplo.com/a')
    expect(resolved.origin).toEqual({ input: 'url', name: 'Página de Teste', url: 'https://exemplo.com/a', storage: 'none' })
    expect(progress).toHaveBeenCalledWith('Lendo a página')
  })

  it('YouTube link uses youtube-transcript.ai by default with the transcription language', async () => {
    const { calls } = installFetch(request => (request.url.includes('oembed') ? jsonResponse({ title: 'Vídeo' }) : new Response('fala')))
    const resolved = await resolveInput({ kind: 'link', url: 'https://youtu.be/dQw4w9WgXcQ' }, withReader('youtube-transcript'), '', progress)
    expect(calls[0].url).toBe('https://youtube-transcript.ai/transcript/dQw4w9WgXcQ.txt?lang=en')
    expect(resolved.origin).toEqual({ input: 'youtube', name: 'Vídeo', url: 'https://youtu.be/dQw4w9WgXcQ', storage: 'none' })
  })

  it('YouTube link uses Gemini when chosen', async () => {
    const { calls } = installFetch(request => (request.url.includes('generativelanguage') ? jsonResponse({ candidates: [{ content: { parts: [{ text: 't' }] } }] }) : jsonResponse({ title: 'V' })))
    await resolveInput({ kind: 'link', url: 'https://youtu.be/dQw4w9WgXcQ' }, withReader('gemini'), '', progress)
    expect(calls[0].url).toContain('gemini-flash-latest:generateContent')
    expect(calls[0].headers['x-goog-api-key']).toBe('gk')
  })

  it('rejects something that is not a link', async () => {
    await expect(resolveInput({ kind: 'link', url: 'nada' }, defaultSettings(), '', progress)).rejects.toBeInstanceOf(SourceError)
  })

  it('text and topic inputs carry their own origin', async () => {
    const text = await resolveInput({ kind: 'text', text: '# Meu texto\nconteúdo' }, defaultSettings(), 'foque em X', progress)
    expect(text.title).toBe('Meu texto')
    expect(text.content).toBe('# Conteúdo\n\n# Meu texto\nconteúdo\n\nfoque em X')
    expect(text.origin).toMatchObject({ input: 'text', name: 'texto colado', mime: 'text/plain', storage: 'none', sizeBytes: new TextEncoder().encode('# Meu texto\nconteúdo').length })
    const topic = await resolveInput({ kind: 'topic', topic: ' Buracos negros ' }, defaultSettings(), '', progress)
    expect(topic.origin).toEqual({ input: 'topic', name: 'Buracos negros', storage: 'none' })
  })

  it('plain text file gets file origin with size and type', async () => {
    const file = new NodeFile(['olá mundo'], 'notas.txt', { type: 'text/plain' }) as unknown as File
    const resolved = await resolveInput({ kind: 'file', file }, defaultSettings(), '', progress)
    expect(resolved.content).toBe('# Conteúdo\n\nolá mundo')
    expect(resolved.origin).toEqual({ input: 'file', name: 'notas.txt', sizeBytes: file.size, mime: 'text/plain', durationSeconds: undefined, storage: 'none' })
  })
})
