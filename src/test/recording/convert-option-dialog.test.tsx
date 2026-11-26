// T184 (dono, 25/11): ao mandar um vídeo em "Novo conteúdo" (Gerar, "Só guardar para ler", Mídias: é o único lugar por onde um vídeo
// entra), a opção "Converter para o formato otimizado". Vem marcada quando o vídeo passa de 200 MB; o pedido leva o que a janela mostra.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { NewContentDialog } from '@/components/dialogs/NewContentDialog'
import { defaultIndex } from '@/lib/defaults'
import type { Repository } from '@/lib/storage/repository'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useModelsStore } from '@/stores/models'
import { installFetch } from '@/test/ai/fake-provider'
import { installBlobShim } from '@/test/imports/blob-shim'

const HEARS = { uid: 'or::omni', pid: 'or', mid: 'omni', name: 'Omni' }
const MB = 1024 * 1024
const startNewContent = vi.fn(async (..._args: unknown[]) => null)
const REAL = useJobsStore.getState()

function seed() {
  const repo = { kind: 'local', accountId: 'local', readContent: async () => '', saveIndex: async () => undefined, fileSizes: async () => ({}) } as unknown as Repository
  const index = defaultIndex()
  index.settings.aiConfig = { providers: [{ id: 'or', type: 'openrouter', name: 'OpenRouter', key: 'k', base: '' }], models: [HEARS], defaults: { estudo: HEARS.uid, ata: HEARS.uid, midia: HEARS.uid }, steps: {} } as never
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  const models = [{ id: 'omni', name: 'Omni', media: { texto: true, imagem: true, audio: true, video: true, pdf: null } }]
  useModelsStore.setState({ live: { or: { state: 'ok', token: 1, at: Date.now(), list: models, byId: new Map(models.map(model => [model.id, model])) } }, probes: {} })
}

const sized = (name: string, type: string, size: number) => {
  const file = new File(['x'], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

async function open(file: File) {
  seed()
  render(
    <MemoryRouter>
      <NewContentDialog />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: /Arquivo/ }))
  fireEvent.change(document.getElementById('nc-file') as HTMLInputElement, { target: { files: [file] } })
  await screen.findByText('O que guardar da fonte')
}

const option = () => screen.getByRole('checkbox', { name: /Converter para o formato otimizado/ })
/** The kind of the file is read from its first bytes: the option comes a moment after the file. */
const shown = () => screen.findByRole('checkbox', { name: /Converter para o formato otimizado/ })
const noOption = () => expect(screen.queryByRole('checkbox', { name: /Converter para o formato otimizado/ })).not.toBeInTheDocument()
const keepOnly = () => fireEvent.click(screen.getByRole('radio', { name: /^Só guardar para ler/ }))
const send = () => fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
const asked = () => startNewContent.mock.calls[0][0] as { optimize?: boolean }

function withCodecs() {
  for (const name of ['VideoEncoder', 'VideoDecoder', 'AudioEncoder', 'AudioDecoder']) vi.stubGlobal(name, class {})
}

beforeEach(() => {
  installBlobShim()
  installFetch(() => new Response('{}'))
  startNewContent.mockClear()
  useJobsStore.setState({ jobs: [], startNewContent } as never)
})

afterEach(() => {
  useJobsStore.setState({ startNewContent: REAL.startNewContent })
  vi.unstubAllGlobals()
})

describe('Converter para o formato otimizado', () => {
  it('um vídeo de 300 MB: vem marcada, diz quanto fica e que converte neste computador; o pedido leva', async () => {
    withCodecs()
    await open(sized('aula.mp4', 'video/mp4', 300 * MB))
    await shown()
    expect(option()).toHaveAttribute('aria-checked', 'true')
    expect(option()).toHaveTextContent(/mesmo formato da gravação do app/)
    expect(option()).toHaveTextContent(/neste computador/)
    keepOnly()
    send()
    await waitFor(() => expect(startNewContent).toHaveBeenCalled())
    expect(asked().optimize).toBe(true)
  })

  it('um vídeo de 80 MB: vem desmarcada; marcar leva a conversão no pedido', async () => {
    withCodecs()
    await open(sized('aula.mp4', 'video/mp4', 80 * MB))
    await shown()
    expect(option()).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(option())
    expect(option()).toHaveAttribute('aria-checked', 'true')
    keepOnly()
    send()
    await waitFor(() => expect(startNewContent).toHaveBeenCalled())
    expect(asked().optimize).toBe(true)
  })

  it('desmarcada, o pedido vai sem conversão', async () => {
    withCodecs()
    await open(sized('aula.mp4', 'video/mp4', 300 * MB))
    await shown()
    fireEvent.click(option())
    keepOnly()
    send()
    await waitFor(() => expect(startNewContent).toHaveBeenCalled())
    expect(asked().optimize).toBeUndefined()
  })

  it('áudio e documento não têm a opção', async () => {
    withCodecs()
    await open(sized('podcast.mp3', 'audio/mpeg', 300 * MB))
    await screen.findByText('Transcrição')
    noOption()
  })

  it('o navegador que não converte: a opção desligada, dizendo por quê, e o pedido vai sem conversão', async () => {
    await open(sized('aula.mp4', 'video/mp4', 300 * MB))
    await shown()
    expect(option()).toBeDisabled()
    expect(option()).toHaveAttribute('aria-checked', 'false')
    expect(option()).toHaveTextContent('Este navegador não converte vídeo: ele vai como está.')
    keepOnly()
    send()
    await waitFor(() => expect(startNewContent).toHaveBeenCalled())
    expect(asked().optimize).toBeUndefined()
  })
})
