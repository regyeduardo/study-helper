import { defaultIndex } from '@/lib/defaults'
import type { Repository } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import type { FileSidecar } from '@/types/domain'

export function studyLibrary() {
  const sidecars = new Map<string, FileSidecar>()
  const contents = new Map<string, string>()
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: async (id: string) => contents.get(id) ?? '',
    readSidecar: async (id: string) => sidecars.get(id)!,
    saveFile: async (sidecar: FileSidecar, content?: string) => {
      sidecars.set(sidecar.meta.id, sidecar)
      if (content !== undefined) contents.set(sidecar.meta.id, content)
      return sidecar
    },
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
  } as unknown as Repository
  const index = defaultIndex()
  index.settings.ai = { provider: 'custom', baseUrl: 'https://api.exemplo.dev/v1', apiKey: 'test-key', model: 'default' }
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useUiStore.setState({ overlay: null })
  return { sidecars, contents }
}

export async function studyNote(): Promise<string> {
  const meta = await useLibraryStore.getState().createFile({ name: 'Limites', type: 'class', status: 'ready', folderId: null }, '# Limites\n\nSe os laterais diferem, o limite não existe. Continuidade exige limite igual ao valor.')
  return meta.id
}
