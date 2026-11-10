import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { AtaPartsDialog } from '@/components/dialogs/AtaPartsDialog'
import { CardsDialog } from '@/components/dialogs/CardsDialog'
import { GenerateDialog } from '@/components/dialogs/GenerateDialog'
import { defaultIndex } from '@/lib/defaults'
import { passSettings } from '@/lib/generation/ata-ai'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { installFetch, openAiStream } from '@/test/ai/fake-provider'
import { studyLibrary, studyNote } from '@/test/generation/study-fixture'
import type { AiConfig } from '@/types/domain'

const mine = { id: 'mine', type: 'custom' as const, name: 'Minha IA', key: 'k', base: 'https://api.exemplo.dev/v1' }
const di = { id: 'di', type: 'deepinfra' as const, name: 'DeepInfra', key: 'di-key', base: '' }
const A = { uid: 'mine::modelo-a', pid: 'mine', mid: 'modelo-a', name: 'Modelo A' }
const B = { uid: 'mine::modelo-b', pid: 'mine', mid: 'modelo-b', name: 'Modelo B' }
const OMNI = { uid: 'di::nvidia/Nemotron-Omni', pid: 'di', mid: 'nvidia/Nemotron-Omni', name: 'Nemotron-Omni' }

function withConfig(aiConfig: AiConfig) {
  useLibraryStore.setState(state => ({ index: { ...state.index, settings: { ...state.index.settings, aiConfig } } }))
}

afterEach(() => vi.unstubAllGlobals())

describe('the model selector at generation time', () => {
  it('comes with the default preselected (old settings included) and the generation uses the model picked there', async () => {
    const { calls } = installFetch(() => openAiStream('{"cartoes": [{"frente": "Limite", "verso": "Valor de aproximação"}]}'))
    studyLibrary()
    const id = await studyNote()
    const { unmount } = render(<CardsDialog fileId={id} />)
    expect(await screen.findByLabelText('Modelo da IA')).toHaveValue('custom::default')
    unmount()
    withConfig({ providers: [mine], models: [A, B], defaults: { estudo: A.uid }, steps: {} })
    render(<CardsDialog fileId={id} />)
    expect(await screen.findByLabelText('Modelo da IA')).toHaveValue(A.uid)
    fireEvent.change(screen.getByLabelText('Modelo da IA'), { target: { value: B.uid } })
    fireEvent.click(screen.getByRole('button', { name: 'Fazer os cartões' }))
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls[0].url).toBe('https://api.exemplo.dev/v1/chat/completions')
    expect(calls[0].body?.model).toBe('modelo-b')
  })

  it('without a default, the person picks there before generating', async () => {
    installFetch(() => openAiStream('{"cartoes": []}'))
    studyLibrary()
    const id = await studyNote()
    withConfig({ providers: [mine], models: [A, B], defaults: {}, steps: {} })
    render(<CardsDialog fileId={id} />)
    const make = await screen.findByRole('button', { name: 'Fazer os cartões' })
    expect(make).toBeDisabled()
    expect(screen.getByText('Sem modelo padrão para Cartões: escolha um aqui.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Modelo da IA'), { target: { value: A.uid } })
    expect(make).toBeEnabled()
  })

  it('for a recording, the Ata dialog no longer has the box "o modelo de vídeo também escreve o documento": each step has its own model (FR-072)', async () => {
    const generateAta = vi.fn(async () => undefined)
    studyLibrary()
    useJobsStore.setState({ generateAta })
    const meta = await useLibraryStore.getState().createFile({ name: 'Reunião', type: 'reading', status: 'ready', folderId: null, origin: { input: 'recording', name: 'Reunião.webm', mime: 'video/webm', storage: 'none' } }, '')
    withConfig({ providers: [mine, di], models: [A, OMNI], defaults: { estudo: A.uid, midia: OMNI.uid }, steps: { revisar: A.uid } })
    render(<AtaPartsDialog fileId={meta.id} />)
    expect(screen.getByLabelText('Modelo da IA')).toHaveValue(A.uid)
    expect(screen.queryByLabelText(/também escreve o documento/)).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Modelos por passo' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))
    expect(generateAta).toHaveBeenCalledWith(meta.id, ['resumo'], undefined, { model: A.uid }, 'home', '', undefined, 'transcricao')
  })

  it('for an Aula of a recording, the dialog offers that the video model also writes the document, as it did', async () => {
    const generateFromNote = vi.fn(async () => 'nota')
    studyLibrary()
    useJobsStore.setState({ generateFromNote })
    const meta = await useLibraryStore.getState().createFile({ name: 'Reunião', type: 'reading', status: 'ready', folderId: null, origin: { input: 'recording', name: 'Reunião.webm', mime: 'video/webm', storage: 'none' } }, '')
    withConfig({ providers: [mine, di], models: [A, OMNI], defaults: { estudo: A.uid, midia: OMNI.uid }, steps: {} })
    render(
      <MemoryRouter>
        <GenerateDialog fileId={meta.id} agent="lesson" />
      </MemoryRouter>,
    )
    expect(screen.getByLabelText('Modelo da IA')).toHaveValue(A.uid)
    fireEvent.click(screen.getByLabelText('O modelo de vídeo (Nemotron-Omni · DeepInfra) também escreve o documento'))
    expect(screen.getByLabelText('Modelo da IA')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))
    expect(generateFromNote.mock.calls[0].slice(0, 3)).toEqual([meta.id, 'lesson', OMNI.uid])
  })

  it('the Ata of a recording is not asked about the box: the Ata goes through the model of each step', async () => {
    studyLibrary()
    const meta = await useLibraryStore.getState().createFile({ name: 'Reunião', type: 'reading', status: 'ready', folderId: null, origin: { input: 'recording', name: 'Reunião.webm', mime: 'video/webm', storage: 'none' } }, '')
    withConfig({ providers: [mine, di], models: [A, OMNI], defaults: { estudo: A.uid, ata: A.uid, midia: OMNI.uid }, steps: {} })
    render(
      <MemoryRouter>
        <GenerateDialog fileId={meta.id} agent="meeting" />
      </MemoryRouter>,
    )
    expect(screen.queryByLabelText(/também escreve o documento/)).not.toBeInTheDocument()
  })

  it('"Gerar de novo" an Aula comes back with its model, and with the box marked when the video model wrote it', async () => {
    const generateFromNote = vi.fn(async () => 'nota')
    studyLibrary()
    useJobsStore.setState({ generateFromNote })
    const meta = await useLibraryStore.getState().createFile({ name: 'Reunião', type: 'reading', status: 'ready', folderId: null, origin: { input: 'recording', name: 'Reunião.webm', mime: 'video/webm', storage: 'none' } }, '')
    const made = async (extra: { everyStep?: boolean }) => {
      const note = await useLibraryStore.getState().createFile({ name: 'Aula: Reunião', type: 'class', status: 'ready', folderId: null, parentFileId: meta.id, origin: { input: 'text', name: 'Reunião', storage: 'none' } }, 'Aula')
      await useLibraryStore.getState().saveContent(note.id, 'Aula', { made: { at: '2026-11-05T10:00:00.000Z', model: OMNI.uid, ...extra } })
      return note
    }
    withConfig({ providers: [mine, di], models: [A, B, OMNI], defaults: { estudo: A.uid, midia: OMNI.uid }, steps: {} })
    const plain = await made({})
    const { unmount } = render(
      <MemoryRouter>
        <GenerateDialog fileId={meta.id} agent="lesson" again={plain.id} />
      </MemoryRouter>,
    )
    expect(screen.getByLabelText('Modelo da IA')).toHaveValue(OMNI.uid)
    expect(screen.getByLabelText('O modelo de vídeo (Nemotron-Omni · DeepInfra) também escreve o documento')).not.toBeChecked()
    unmount()
    const every = await made({ everyStep: true })
    render(
      <MemoryRouter>
        <GenerateDialog fileId={meta.id} agent="lesson" again={every.id} />
      </MemoryRouter>,
    )
    expect(screen.getByLabelText('O modelo de vídeo (Nemotron-Omni · DeepInfra) também escreve o documento')).toBeChecked()
    expect(screen.getByLabelText('Modelo da IA')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))
    expect(generateFromNote.mock.calls[0].slice(0, 3)).toEqual([meta.id, 'lesson', OMNI.uid])
  })

  it('"Gerar de novo" a Ata of a video comes back with the models of each step of the last time', async () => {
    const generateAta = vi.fn(async () => undefined)
    studyLibrary()
    useJobsStore.setState({ generateAta })
    const meta = await useLibraryStore.getState().createFile({ name: 'Reunião', type: 'reading', status: 'ready', folderId: null, origin: { input: 'recording', name: 'Reunião.webm', mime: 'video/webm', storage: 'none' } }, '')
    const before = await useLibraryStore.getState().createFile({ name: 'Ata: Reunião', type: 'meeting', status: 'ready', folderId: null, parentFileId: meta.id, origin: { input: 'text', name: 'Reunião', storage: 'none' } }, 'Ata')
    await useLibraryStore.getState().saveContent(before.id, 'Ata', { made: { at: '2026-11-05T10:00:00.000Z', parts: ['resumo'], model: B.uid, analyze: 'transcricao', steps: { video: OMNI.uid, context: A.uid } } })
    withConfig({ providers: [mine, di], models: [A, B, OMNI], defaults: { estudo: A.uid, midia: OMNI.uid }, steps: {} })
    render(<AtaPartsDialog fileId={meta.id} again={before.id} />)
    expect(screen.getByLabelText('Modelo da IA')).toHaveValue(B.uid)
    fireEvent.click(screen.getByRole('button', { name: /^Modelos por passo/ }))
    const step = (name: string) => within(screen.getByRole('group', { name })).getByRole('combobox')
    expect(step('Vídeo')).toHaveValue(OMNI.uid)
    expect(step('Contexto')).toHaveValue(A.uid)
    expect(step('Escrita')).toHaveValue(B.uid)
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))
    expect(generateAta).toHaveBeenCalledWith(meta.id, ['resumo'], undefined, { model: B.uid, write: B.uid, video: OMNI.uid, context: A.uid }, { replace: before.id }, '', undefined, 'transcricao')
  })

  it('in the Ata, a step with its own model keeps it, unless the person picked a model for that step', () => {
    const settings = { ...defaultIndex().settings, aiConfig: { providers: [mine, di], models: [A, B, OMNI], defaults: { estudo: A.uid }, steps: { revisar: B.uid } } }
    expect(passSettings(settings, 'review').model).toBe('modelo-b')
    expect(passSettings(settings, 'write').model).toBe('modelo-a')
    expect(passSettings(settings, 'write', { model: OMNI.uid }).model).toBe('nvidia/Nemotron-Omni')
    expect(passSettings(settings, 'review', { model: OMNI.uid }).model).toBe('modelo-b')
    expect(passSettings(settings, 'review', { model: OMNI.uid, write: OMNI.uid })).toEqual({ provider: 'deepinfra', baseUrl: '', apiKey: 'di-key', model: 'nvidia/Nemotron-Omni' })
  })
})
