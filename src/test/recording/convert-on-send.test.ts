// T184 (dono, 25/11): com "Converter para o formato otimizado" marcado, o vídeo enviado em "Novo conteúdo" vira o formato da gravação
// otimizada antes de tudo; o convertido é o que fica (o original continua no computador de quem mandou) e o que é lido. O que não dá para
// converter vai como estava, dizendo por quê: o envio nunca se perde.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'

const converted = vi.hoisted(() => ({ run: vi.fn() }))

// "Só guardar para ler" transcribes the media: the transcription answers at once
vi.mock('@/lib/transcription', () => ({
  ENGINES: [],
  transcribe: vi.fn(async () => ({
    text: 'Ana: vamos lançar em maio?',
    engine: 'groq',
    language: 'pt',
    durationSeconds: 8,
    speakers: 1,
    recording: { blocks: [{ speaker: 'mic', start: 0, end: 3, text: 'Vamos lançar em maio?' }], speakers: [{ id: 'mic', name: 'Ana', suggested: false }], marks: [] },
  })),
}))

vi.mock('@/lib/recording/convert-video', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/recording/convert-video')>()),
  convertVideo: converted.run,
}))

import { NotConvertible } from '@/lib/recording/convert-video'
import { listLocalMedia } from '@/lib/recording/media-library'
import { type NewContentRequest, useJobsStore } from '@/stores/jobs'
import { useUiStore } from '@/stores/ui'
import { installFetch } from '@/test/ai/fake-provider'
import { fileOf, memoryLibrary, provider } from '@/test/source-meta/fixture'

const media = (name: string, type: string, size = 8) => new NodeFile([new Uint8Array(size)], name, { type }) as unknown as File

function keep(file: File, optimize?: boolean): NewContentRequest {
  // "Registro e arquivo", kept in Mídias (on this computer), as the window sends it
  return { agent: 'reading', input: { kind: 'file', file }, name: '', description: '', folderId: null, prompt: '', keep: 'arquivo', storage: 'none', litterboxTime: '72h' as NewContentRequest['litterboxTime'], ...(optimize === undefined ? {} : { optimize }) }
}

/** The folder of Mídias in this browser, in memory. */
function installBrowserFolder(): Map<string, Blob> {
  const files = new Map<string, Blob>()
  const handle = (name: string) => ({
    getFile: async () => {
      const blob = files.get(name)
      if (!blob) throw new DOMException('missing', 'NotFoundError')
      return new NodeFile([blob as never], name)
    },
    createWritable: async () => {
      const parts: BlobPart[] = []
      return { write: async (data: BlobPart) => void parts.push(data), close: async () => void files.set(name, new NodeBlob(parts as never) as unknown as Blob) }
    },
  })
  const folder = {
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name) && !options?.create) throw new DOMException('missing', 'NotFoundError')
      return handle(name)
    },
    removeEntry: async (name: string) => void files.delete(name),
  }
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => folder } })
  return files
}

/** Every message the job of the request showed, in order. */
function messages(): string[] {
  const seen: string[] = []
  useJobsStore.subscribe(state => {
    const last = state.jobs.at(-1)?.message
    if (last && seen.at(-1) !== last) seen.push(last)
  })
  return seen
}

beforeEach(() => {
  memoryLibrary()
  installFetch(provider)
  installBrowserFolder()
  converted.run.mockReset()
  useUiStore.setState({ toasts: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('enviar um vídeo com "Converter para o formato otimizado"', () => {
  it('o convertido é o que fica em Mídias e na nota; a janela diz que converte, com o andamento', async () => {
    const seen = messages()
    converted.run.mockImplementation(async (_file: File, onProgress: (fraction: number) => void) => {
      onProgress(0.5)
      return media('aula.webm', 'video/webm', 3)
    })
    const id = await useJobsStore.getState().startNewContent(keep(media('aula.mp4', 'video/mp4', 8), true))
    expect(converted.run.mock.calls[0][0]).toMatchObject({ name: 'aula.mp4' })
    expect(seen).toContain('Convertendo o vídeo para o formato otimizado')
    await waitFor(async () => expect(await listLocalMedia()).toHaveLength(1))
    const [kept] = await listLocalMedia()
    expect(kept).toMatchObject({ name: 'aula.webm', mime: 'video/webm', size: 3, fileIds: [id] })
    expect(fileOf(id!).origin).toMatchObject({ name: 'aula.webm', mime: 'video/webm', sizeBytes: 3 })
  })

  it('sem a opção, o vídeo vai como veio', async () => {
    const id = await useJobsStore.getState().startNewContent(keep(media('aula.mp4', 'video/mp4', 8)))
    expect(converted.run).not.toHaveBeenCalled()
    await waitFor(async () => expect(await listLocalMedia()).toHaveLength(1))
    expect(fileOf(id!).origin).toMatchObject({ name: 'aula.mp4', mime: 'video/mp4' })
  })

  it('o que não dá para converter vai como estava, e um aviso diz por quê', async () => {
    converted.run.mockRejectedValue(new NotConvertible('este navegador não lê o vídeo deste arquivo'))
    const id = await useJobsStore.getState().startNewContent(keep(media('aula.mov', 'video/quicktime', 8), true))
    await waitFor(async () => expect(await listLocalMedia()).toHaveLength(1))
    expect(fileOf(id!).origin).toMatchObject({ name: 'aula.mov', mime: 'video/quicktime' })
    expect(useUiStore.getState().toasts.map(toast => toast.text)).toContain('O vídeo não foi convertido: este navegador não lê o vídeo deste arquivo. Ele foi como estava.')
  })

  it('cancelar na conversão cancela o envio: nada é criado', async () => {
    converted.run.mockImplementation(async () => {
      const job = useJobsStore.getState().jobs.at(-1)!
      useJobsStore.getState().cancel(job.id)
      throw new DOMException('Cancelado por você.', 'AbortError')
    })
    const id = await useJobsStore.getState().startNewContent(keep(media('aula.mp4', 'video/mp4', 8), true))
    expect(id).toBeNull()
    expect(useJobsStore.getState().jobs.at(-1)).toMatchObject({ status: 'cancelled' })
    expect(await listLocalMedia()).toHaveLength(0)
  })

  it('um áudio não é convertido, mesmo com a opção', async () => {
    await useJobsStore.getState().startNewContent(keep(media('podcast.mp3', 'audio/mpeg', 8), true))
    expect(converted.run).not.toHaveBeenCalled()
  })
})
