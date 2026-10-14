import { render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { defaultIndex } from '@/lib/defaults'
import type { Repository } from '@/lib/storage/repository'
import { useViewRoute } from '@/hooks/use-view-route'
import { ReaderWorkspace } from '@/pages/workspace/container/reader'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import type { FileMeta, FileSidecar, FolderMeta, RecordingData, SourceMeta } from '@/types/domain'

const stamp = { at: '2026-10-10T10:00:00Z', deviceId: 'local', deviceName: 'Este computador' }

function folder(id: string, name: string, parentId: string | null, position = 0): FolderMeta {
  return { id, name, parentId, position, created: stamp, updated: stamp, deletedAt: null } as unknown as FolderMeta
}

function file(id: string, name: string, folderId: string | null, extra: Partial<FileMeta> = {}): FileMeta {
  return {
    id,
    name,
    folderId,
    type: 'reading',
    description: '',
    status: 'ready',
    position: 0,
    favorite: false,
    tags: [],
    parentFileId: null,
    sourceExcerpt: null,
    pendingExcerpt: null,
    origin: null,
    generation: null,
    created: stamp,
    updated: stamp,
    deletedAt: null,
    words: 100,
    readingMinutes: 1,
    mastery: null,
    lastReviewedAt: null,
    questionCount: 0,
    ...extra,
  }
}

const audio = (minutes: number): SourceMeta => ({ input: 'recording', name: 'gravacao.webm', mime: 'audio/webm', durationSeconds: minutes * 60, storage: 'none' })
const video = (minutes: number): SourceMeta => ({ input: 'file', name: 'aula.mp4', mime: 'video/mp4', durationSeconds: minutes * 60, storage: 'none' })

const monitoria: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 12, end: 30, text: 'Hoje a gente fecha limites laterais.' },
    { speaker: 'speaker_0', start: 40, end: 52, text: 'Pode, e aí o limite da função não existe.' },
  ],
  speakers: [
    { id: 'mic', name: 'Você', suggested: false },
    { id: 'speaker_0', name: 'Monitor', suggested: false },
  ],
  marks: [],
}

export const FOLDERS = [folder('calc', 'Cálculo I', null, 0), folder('integ', 'Integrais', 'calc', 0), folder('exer', 'Exercícios', 'calc', 1), folder('fis', 'Física II', null, 1)]

export const FILES = [
  file('limites', 'Limites laterais e continuidade', 'calc', { tags: ['limites'], mastery: 70 }),
  file('monitoria', 'Monitoria de limites', 'calc', { tags: ['limites'], origin: audio(52) }),
  file('derivadas-video', 'Aula gravada: derivadas', 'calc', { tags: ['derivadas'], origin: video(70) }),
  file('derivadas', 'Derivadas pela definição', 'calc', { tags: ['derivadas'], mastery: 80 }),
  file('stewart', 'Stewart, capítulo 2', 'integ', { tags: ['limites'] }),
  file('ondas', 'Ondas', 'fis'),
]

const CONTENTS: Record<string, string> = {
  limites: '# Limites\n\nSe os laterais diferem, o limite não existe.',
  monitoria: 'Você [00:12]: Hoje a gente fecha limites laterais.',
  'derivadas-video': '',
  derivadas: '# Derivadas\n\nA derivada é um limite.',
  stewart: 'Página 14: o limite não existe quando os laterais diferem.',
  ondas: 'Ondas e frequência.',
}

export function seedLibrary() {
  const sidecar = (meta: FileMeta): FileSidecar => ({ meta, highlights: [], questions: [], ...(meta.id === 'monitoria' ? { recording: monitoria } : {}) }) as unknown as FileSidecar
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: async (id: string) => CONTENTS[id] ?? '',
    readSidecar: async (id: string) => sidecar(FILES.find(item => item.id === id)!),
    saveFile: async (saved: FileSidecar) => saved,
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
  } as unknown as Repository
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: FOLDERS, files: FILES, index: defaultIndex(), opened: {}, openedAt: {}, localMedia: [], sharedView: null, sizes: {} })
  useUiStore.getState().clearFilters()
}

function Workspace() {
  return <ReaderWorkspace route={useViewRoute()} />
}

export function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/biblioteca/:folderId?" element={<Workspace />} />
        <Route path="/arquivo/:fileId" element={<Workspace />} />
        <Route path="*" element={<Workspace />} />
      </Routes>
    </MemoryRouter>,
  )
}
