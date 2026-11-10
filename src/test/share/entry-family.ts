// A entrada de vídeo com a sua família, para os testes de compartilhar uma entrada (história 7).
import { vi } from 'vitest'

import type { Artifact, CardsArtifact, FileMeta, FileSidecar, FolderMeta, MapArtifact, RecordingData, SourceMeta, StoredQuestion, TutorArtifact } from '@/types/domain'
import { artifactMeta } from '@/lib/artifacts'
import { newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import type { Repository } from '@/lib/storage/repository'

const MB = 1024 * 1024
const stamp = (at: string) => ({ at, deviceId: 'd1', deviceName: 'Notebook' })

export const ENTRY_NAME = 'Reunião de planejamento 09/11'

export const VIDEO: SourceMeta = { input: 'file', name: 'planejamento.mp4', mime: 'video/mp4', sizeBytes: 412 * MB, durationSeconds: 68 * 60, storage: 'drive', storedFileId: 'drv-da-ana', expiresAt: null }

export const RECORDING: RecordingData = {
  blocks: [
    { speaker: 's1', start: 12, end: 20, text: 'Vamos fechar o portal novo até março.' },
    { speaker: 's2', start: 100, end: 110, text: 'O contrato sai na semana que vem.' },
  ],
  speakers: [
    { id: 's1', name: 'Marina', suggested: false },
    { id: 's2', name: 'Rafael', suggested: false },
  ],
  marks: [],
}

export const QUESTION: StoredQuestion = { storedId: 'q1', tipo: 'unica', enunciado: 'Quando sai o portal?', alternativas: { A: 'Março', B: 'Junho' }, correta: 'A', explicacao: 'Dito em 00:12.' }

const AT = '2026-11-09T12:00:00.000Z'

export const MAP: MapArtifact = {
  id: 'm1',
  kind: 'mapa',
  name: 'Portal novo',
  createdAt: AT,
  updatedAt: AT,
  diagram: { form: 'arvore', root: { id: 'r', text: 'Portal novo', children: [{ id: 'a', text: 'Até março', children: [] }] } },
  versions: [],
  chat: [{ who: 'você', text: 'Pergunta do mapa', at: AT }],
}

export const DECK: CardsArtifact = { id: 'c1', kind: 'cartoes', name: 'Cartões da reunião', createdAt: AT, updatedAt: AT, cards: [{ id: 'k1', front: 'Prazo do portal?', back: 'Março.', box: 3, due: '2026-12-01' }] }

export const TALK: TutorArtifact = { id: 't1', kind: 'tutor', name: 'Dúvidas sobre contratos', createdAt: AT, updatedAt: AT, turns: [{ who: 'você', text: 'O que é aditivo?' }, { who: 'tutor', text: 'Uma mudança no contrato.' }] }

export const CONTENTS: Record<string, string> = {
  e: '',
  ata: '# Ata\n\nDecidimos o portal novo.',
  aula: '# Aula\n\nContratos de prestação de serviço.',
  exp: '# Explicação\n\nO que muda num aditivo.',
  velha: '# Nota apagada',
}

export let reunioes: FolderMeta

function note(id: string, fields: Partial<FileMeta>, artifacts: Artifact[] = []): FileSidecar {
  const meta = newFileMeta({ id, name: id, type: 'class', folderId: reunioes.id, created: stamp(fields.created?.at ?? AT), updated: stamp(AT), ...fields, ...(artifacts.length ? artifactMeta(artifacts) : {}) })
  return { ...newSidecar(meta), ...(artifacts.length ? { artifacts } : {}) }
}

/** e (vídeo, transcrita) › Ata (mapa e cartões) e Aula › Explicação (conversa do Tutor); uma nota na Lixeira. */
export function entryFamily(): FileSidecar[] {
  reunioes = newFolderMeta({ id: 'reunioes', name: 'Reuniões da Ana' })
  const entry = note('e', { name: ENTRY_NAME, role: 'entrada', kept: 'arquivo', type: 'meeting', origin: VIDEO, created: stamp('2026-11-09T10:00:00.000Z') })
  return [
    { ...entry, transcript: 'Marina: vamos fechar o portal novo até março.', recording: RECORDING },
    { ...note('ata', { name: 'Ata', type: 'meeting', parentFileId: 'e', created: stamp('2026-11-09T11:00:00.000Z'), origin: { input: 'text', name: ENTRY_NAME, storage: 'none' } }, [MAP, DECK]), questions: [QUESTION] },
    note('aula', { name: 'Aula', type: 'class', parentFileId: 'e', created: stamp('2026-11-09T11:30:00.000Z') }),
    note('exp', { name: 'Explicação: contratos', type: 'explanation', parentFileId: 'aula', created: stamp('2026-11-09T11:45:00.000Z') }, [TALK]),
    note('velha', { name: 'Nota apagada', parentFileId: 'e', deletedAt: '2026-11-09T13:00:00.000Z' }),
  ]
}

/** A repository in memory, like the browser's, with the media sent to the Drive counted. */
export function memoryRepository(sidecars: FileSidecar[] = [], contents: Record<string, string> = {}) {
  const kept = new Map(sidecars.map(sidecar => [sidecar.meta.id, sidecar]))
  const texts = new Map(Object.entries(contents))
  const folders = new Map<string, FolderMeta>()
  const putSource = vi.fn(async () => ({ ref: 'drive-nova' }))
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: async (id: string) => texts.get(id) ?? '',
    readSidecar: async (id: string) => kept.get(id)!,
    saveFile: async (sidecar: FileSidecar, content?: string) => {
      kept.set(sidecar.meta.id, sidecar)
      if (content !== undefined) texts.set(sidecar.meta.id, content)
      return sidecar
    },
    saveFolder: async (folder: FolderMeta) => void folders.set(folder.id, folder),
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
    putSource,
  } as unknown as Repository
  return { repo, putSource, folders }
}
