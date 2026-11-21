// T145: wherever a note or a transcription is (re)made there is the instruction field, open when redoing; `made` keeps the model even without an instruction.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { File as NodeFile } from 'node:buffer'

const { heard } = vi.hoisted(() => ({
  heard: {
    blocks: [
      { speaker: 'mic', start: 0, end: 3, text: 'Vamos falar do PIX.' },
      { speaker: 'speaker_0', start: 4, end: 8, text: 'O pics entra em maio.' },
    ],
    speakers: [
      { id: 'mic', name: 'Você', suggested: false },
      { id: 'speaker_0', name: 'Falante 2', suggested: false },
    ],
    marks: [],
  },
}))

vi.mock('@/lib/transcription', () => ({
  ENGINES: [],
  transcribe: vi.fn(async () => ({ text: 'bruto', engine: 'deepinfra', language: 'pt', durationSeconds: 8, speakers: 2, recording: heard })),
}))

vi.mock('@/lib/recording/media-library', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/recording/media-library')>()),
  readLocalMedia: vi.fn(async () => new NodeFile([new Uint8Array(4)], 'Reunião.webm', { type: 'audio/webm' }) as unknown as File),
}))

vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
}))

import { ItemMenu } from '@/components/library/ItemMenu'
import { INSTRUCTION_HEAD } from '@/lib/generation/instruction'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { fileOf, FORTE, flowLibrary, GERAL, modelOf, renderAt, sentTo, textSource, userContentOf } from '@/test/generation/flow-fixture'
import type { RecordingData } from '@/types/domain'

afterEach(() => {
  vi.unstubAllGlobals()
})

const instructionIn = (dialog: HTMLElement) => within(dialog).getByLabelText('Instrução extra para a IA (opcional)')
const modelIn = (dialog: HTMLElement, label = 'Modelo da IA') => within(dialog).getByLabelText(label)

/** An entrada of a recording, kept here, already transcribed. */
async function transcribedEntry(): Promise<string> {
  const meta = await useLibraryStore.getState().createFile(
    { name: 'Reunião', role: 'entrada', kept: 'arquivo', type: 'reading', status: 'ready', folderId: null, origin: { input: 'recording', name: 'Reunião.webm', mime: 'audio/webm', durationSeconds: 8, storage: 'none' } },
    'Você: Vamos falar do PIX.',
  )
  await useLibraryStore.getState().updateSidecar(meta.id, sidecar => ({ ...sidecar, recording: heard as RecordingData, transcript: 'Você: Vamos falar do PIX.' }))
  useLibraryStore.setState({ localMedia: [{ storedName: 'r1', name: 'Reunião.webm', mime: 'audio/webm', durationSeconds: 8, size: 4, createdAt: '2026-11-01T10:00:00.000Z', fileIds: [meta.id] }] })
  return meta.id
}

const polishAsked = (calls: Parameters<typeof sentTo>[0]) => sentTo(calls, PROMPTS.POLISH_PROMPT).map(userContentOf)

describe('Refazer a transcrição leva uma instrução para a revisão', () => {
  it('"Refazer a transcrição" (janela Transcrever): o campo vem à vista e a instrução chega à revisão', async () => {
    const { calls } = flowLibrary()
    const id = await transcribedEntry()
    renderAt(`/entrada/${id}`)
    act(() => useUiStore.getState().open({ kind: 'transcribe', fileId: id }))
    const dialog = screen.getByRole('dialog', { name: 'Refazer a transcrição' })
    expect(instructionIn(dialog)).toBeVisible()
    // no default for Transcrição in this library: one is picked
    fireEvent.change(modelIn(dialog, 'Transcrição'), { target: { value: FORTE } })
    fireEvent.change(instructionIn(dialog), { target: { value: 'É PIX, não pics.' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Transcrever' }))
    await waitFor(() => expect(useJobsStore.getState().jobs[0]?.status).toBe('done'))
    expect(polishAsked(calls).length).toBeGreaterThan(0)
    for (const user of polishAsked(calls)) expect(user).toContain(`${INSTRUCTION_HEAD}\n\nÉ PIX, não pics.`)
  })

  it('"Gerar desta nota" › "Refazer a transcrição": também tem a instrução, à vista', async () => {
    const { calls } = flowLibrary()
    const id = await transcribedEntry()
    renderAt(`/entrada/${id}`)
    act(() => useUiStore.getState().open({ kind: 'generate-entry', fileId: id }))
    const dialog = screen.getByRole('dialog', { name: 'Gerar desta nota' })
    fireEvent.click(await within(dialog).findByRole('radio', { name: /Refazer a transcrição/ }))
    expect(instructionIn(dialog)).toBeVisible()
    fireEvent.change(modelIn(dialog), { target: { value: FORTE } })
    fireEvent.change(instructionIn(dialog), { target: { value: 'O nome é João Vitor.' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(useJobsStore.getState().jobs[0]?.status).toBe('done'))
    for (const user of polishAsked(calls)) expect(user).toContain(`${INSTRUCTION_HEAD}\n\nO nome é João Vitor.`)
  })
})

describe('Refazer uma nota: a instrução vem à vista e fica guardada com o modelo', () => {
  it('"Refazer a Aula" de uma nota com a própria transcrição: o campo vem aberto e "made" guarda modelo e instrução', async () => {
    const { calls } = flowLibrary()
    const meta = await useLibraryStore.getState().createFile({ name: 'Aula gravada', type: 'class', status: 'ready', folderId: null, origin: { input: 'recording', name: 'Aula.webm', mime: 'audio/webm', durationSeconds: 8, storage: 'none' } }, '# Antes')
    await useLibraryStore.getState().updateSidecar(meta.id, sidecar => ({ ...sidecar, recording: heard as RecordingData }))
    renderAt(`/arquivo/${meta.id}`)
    act(() => useUiStore.getState().open({ kind: 'generate', fileId: meta.id, agent: 'lesson', redo: true }))
    const dialog = screen.getByRole('dialog', { name: 'Refazer a Aula' })
    expect(instructionIn(dialog)).toBeVisible()
    fireEvent.change(modelIn(dialog), { target: { value: FORTE } })
    fireEvent.change(instructionIn(dialog), { target: { value: 'foque no PIX' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(sentTo(calls, PROMPTS.LESSON_PROMPT)).toHaveLength(1))
    await waitFor(() => expect(fileOf(meta.id).status).toBe('ready'))
    expect(userContentOf(sentTo(calls, PROMPTS.LESSON_PROMPT)[0]).endsWith(`${INSTRUCTION_HEAD}\n\nfoque no PIX`)).toBe(true)
    expect(fileOf(meta.id).made).toMatchObject({ model: FORTE, instruction: 'foque no PIX' })
  })

  it('"Gerar de novo" de uma Aula sem instrução: o campo vem aberto, vazio', async () => {
    flowLibrary()
    const source = await textSource()
    const made = await useJobsStore.getState().generateFromNote(source, 'lesson', FORTE, { folderId: null })
    await waitFor(() => expect(fileOf(made!).status).toBe('ready'))
    useUiStore.getState().openMenu({ kind: 'file', id: made!, x: 1, y: 1 })
    renderAt(`/arquivo/${made}`, <ItemMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Gerar de novo/ }))
    const dialog = screen.getByRole('dialog', { name: 'Gerar de novo a Aula' })
    expect(instructionIn(dialog)).toBeVisible()
    expect(instructionIn(dialog)).toHaveValue('')
    expect(modelIn(dialog)).toHaveValue(FORTE)
  })

  it('uma nota nova sem instrução guarda o modelo usado, para "Gerar de novo"', async () => {
    flowLibrary()
    const id = await useJobsStore.getState().startNewContent({ agent: 'lesson', input: { kind: 'text', text: 'Se os laterais diferem, o limite não existe.' }, name: 'Limites', description: '', folderId: null, prompt: '', storage: 'none', litterboxTime: '24h', models: { write: FORTE } })
    await waitFor(() => expect(fileOf(id!).status).toBe('ready'))
    expect(fileOf(id!).made).toMatchObject({ model: FORTE })
    expect(fileOf(id!).made).not.toHaveProperty('instruction')
  })
})

describe('Explicação de um trecho tem "Gerar de novo"', () => {
  it('o mesmo trecho volta para a IA, com o modelo e a pergunta de antes; o que mudar vale, na mesma nota', async () => {
    const { calls } = flowLibrary()
    const source = await textSource('Limites')
    const excerpt = 'Se os laterais diferem, o limite não existe.'
    const id = await useJobsStore.getState().explainSelection(source, excerpt, 'por que os laterais?', 'context', FORTE)
    await waitFor(() => expect(fileOf(id).status).toBe('ready'))
    expect(fileOf(id).made).toMatchObject({ model: FORTE, instruction: 'por que os laterais?' })
    useUiStore.getState().openMenu({ kind: 'file', id, x: 1, y: 1 })
    renderAt(`/arquivo/${id}`, <ItemMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Gerar de novo/ }))
    const dialog = screen.getByRole('dialog', { name: 'Gerar de novo a Explicação' })
    expect(modelIn(dialog)).toHaveValue(FORTE)
    expect(instructionIn(dialog)).toHaveValue('por que os laterais?')
    fireEvent.change(modelIn(dialog), { target: { value: GERAL } })
    fireEvent.change(instructionIn(dialog), { target: { value: 'com um exemplo numérico' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(sentTo(calls, PROMPTS.EXPLANATION_PROMPT)).toHaveLength(2))
    await waitFor(() => expect(fileOf(id).status).toBe('ready'))
    const again = sentTo(calls, PROMPTS.EXPLANATION_PROMPT)[1]
    expect(modelOf(again)).toBe('geral')
    expect(userContentOf(again)).toContain(excerpt)
    expect(userContentOf(again)).toContain('com um exemplo numérico')
    // replaced: still one explanation, the same note
    expect(useLibraryStore.getState().files.filter(file => file.type === 'explanation')).toHaveLength(1)
    expect(fileOf(id)).toMatchObject({ sourceExcerpt: excerpt, made: { model: GERAL, instruction: 'com um exemplo numérico' } })
  })
})
