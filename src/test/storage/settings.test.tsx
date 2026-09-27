import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'

import { render, screen } from '@testing-library/react'

import type { LibraryIndex, Settings } from '@/types/domain'
import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { defaultIndex, defaultSettings } from '@/lib/defaults'
import { DriveRepository, INDEX_NAME } from '@/lib/storage/drive-repository'
import { LocalRepository } from '@/lib/storage/local-repository'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'

import { FakeDrive, installMemoryStorage, uniqueAccount } from './fake-drive'

const token = vi.fn(async () => 'tok')
let drive: FakeDrive

const chosen: Partial<Settings> = {
  ai: { provider: 'openai', baseUrl: '', apiKey: 'sk-live-123456', model: 'gpt-x' },
  transcription: { engine: 'groq', groqApiKey: 'gsk_abcdef', language: 'pt', separateSpeakers: false },
  timezone: 'America/Manaus',
  githubToken: 'ghp_token987',
}

beforeEach(() => {
  installMemoryStorage()
  drive = new FakeDrive().install()
})

afterEach(() => {
  vi.unstubAllGlobals()
  useLibraryStore.setState({ repo: null })
})

describe('configurações no study-helper.json da pasta', () => {
  it('IA, transcrição, fuso e GitHub vão para o índice no Drive e voltam em outro navegador', async () => {
    await useLibraryStore.getState().connect(uniqueAccount(), token)
    await useLibraryStore.getState().updateSettings(chosen)

    const file = drive.one('index')
    expect(file.name).toBe(INDEX_NAME)
    expect(file.parents).toEqual([drive.root()!.id])
    const saved = JSON.parse(file.content!) as LibraryIndex
    expect(saved.settings).toMatchObject(chosen)

    const other = new DriveRepository(uniqueAccount(), token)
    expect((await other.load()).index.settings).toMatchObject(chosen)
  })

  it('a chave da API fica em texto puro no .json (sem criptografia)', async () => {
    await useLibraryStore.getState().connect(uniqueAccount(), token)
    await useLibraryStore.getState().updateSettings(chosen)
    const raw = drive.one('index').content!
    expect(raw).toContain('"apiKey": "sk-live-123456"')
    expect(raw).toContain('"groqApiKey": "gsk_abcdef"')
    expect(raw).toContain('"githubToken": "ghp_token987"')
  })

  it('no perfil Local as configurações ficam no índice do IndexedDB', async () => {
    const repo = new LocalRepository(`study-helper-local-test-${crypto.randomUUID()}`)
    const snapshot = await repo.load()
    useLibraryStore.setState({ repo, index: snapshot.index })
    await useLibraryStore.getState().updateSettings(chosen)
    expect((await repo.load()).index.settings).toMatchObject(chosen)
  })

  it('mudar uma configuração não apaga as outras', async () => {
    await useLibraryStore.getState().connect(uniqueAccount(), token)
    await useLibraryStore.getState().updateSettings(chosen)
    await useLibraryStore.getState().updateSettings({ timezone: 'UTC' })
    const saved = JSON.parse(drive.one('index').content!) as LibraryIndex
    expect(saved.settings).toMatchObject({ ...chosen, timezone: 'UTC' })
  })

  it('índice antigo sem alguns campos recebe os padrões ao abrir', async () => {
    const seed = new DriveRepository(uniqueAccount(), token)
    await seed.load()
    const index = drive.one('index')
    drive.editContent(index.id, JSON.stringify({ version: 1, settings: { timezone: 'Europe/Lisbon' }, tags: [], activities: [], updated: defaultIndex().updated }))
    await useLibraryStore.getState().connect(uniqueAccount(), token)
    const settings = useLibraryStore.getState().index.settings
    expect(settings.timezone).toBe('Europe/Lisbon')
    expect(settings.ai).toEqual(defaultSettings().ai)
    expect(settings.githubToken).toBe('')
  })
})

describe('a tela mascara as chaves', () => {
  beforeEach(() => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
    useLibraryStore.setState({ index: { ...defaultIndex(), settings: { ...defaultSettings(), ...chosen, youtube: { reader: 'gemini', geminiApiKey: 'AIza-secret' } } as Settings } })
  })

  it('chave da IA aparece como senha (asteriscos)', () => {
    render(<SettingsDialog initial="ai" />)
    const input = screen.getByLabelText(/Chave da API/)
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveValue('sk-live-123456')
    expect(document.body.textContent).not.toContain('sk-live-123456')
  })

  it('chaves da Groq e do Gemini aparecem como senha', () => {
    render(<SettingsDialog initial="transcription" />)
    expect(screen.getByLabelText('Chave da Groq')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Chave do Gemini')).toHaveAttribute('type', 'password')
    expect(document.body.textContent).not.toContain('gsk_abcdef')
    expect(document.body.textContent).not.toContain('AIza-secret')
  })

  it('token do GitHub aparece como senha e o fuso vem do índice', () => {
    render(<SettingsDialog initial="general" />)
    const input = screen.getByLabelText(/Token do GitHub/)
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveValue('ghp_token987')
    expect(screen.getByLabelText('Fuso horário')).toHaveValue('America/Manaus')
  })
})
