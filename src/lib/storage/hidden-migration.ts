import type { FileSidecar, FolderMeta } from '@/types/domain'
import { DriveError, hasAppDataAccessController, type TokenProvider } from '@/controllers/drive.controller'
import { DriveRepository } from '@/lib/storage/drive-repository'

const MAX_VISIBLE_FOLDERS = 5

export type MigrationReport = (message: string, fraction: number | null) => void

export interface DriveLibrary {
  repo: DriveRepository
  hiddenPending: boolean
  warning: string | null
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>)
            .filter(([, inner]) => inner !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  )
}

function byDepth(folders: FolderMeta[]): FolderMeta[] {
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const depth = (folder: FolderMeta) => {
    let levels = 0
    let parent = folder.parentId
    while (parent && byId.has(parent) && levels < 64) {
      levels++
      parent = byId.get(parent)!.parentId
    }
    return levels
  }
  return [...folders].sort((a, b) => depth(a) - depth(b))
}

function withoutSourceRef(sidecar: FileSidecar): string {
  const origin = sidecar.meta.origin ? { ...sidecar.meta.origin, storedFileId: undefined } : sidecar.meta.origin
  return stable({ ...sidecar, meta: { ...sidecar.meta, origin } })
}

function keepsSource(sidecar: FileSidecar): string | null {
  const origin = sidecar.meta.origin
  return origin?.storage === 'drive' && origin.storedFileId && !origin.removedAt ? origin.storedFileId : null
}

export async function copyToHidden(visible: DriveRepository, hidden: DriveRepository, report: MigrationReport, keepHiddenSettings = false): Promise<void> {
  const source = await visible.load()
  const target = await hidden.load()
  const total = source.folders.length + source.files.length + 2
  let done = 0
  const step = (message: string) => report(message, ++done / total)
  for (const folder of byDepth(source.folders)) {
    await hidden.saveFolder(folder)
    step(`Pasta ${folder.name}`)
  }
  for (const meta of source.files) {
    const [content, sidecar] = await Promise.all([visible.readContent(meta.id), visible.readSidecar(meta.id)])
    const stored = keepsSource(sidecar)
    let next = sidecar
    if (stored) {
      const ref = hidden.sourceRefFor(meta.id) ?? (await hidden.putSource(meta.id, await visible.getSource(stored), sidecar.meta.origin!.name)).ref
      next = { ...sidecar, meta: { ...sidecar.meta, origin: { ...sidecar.meta.origin!, storedFileId: ref } } }
    }
    await hidden.saveFile(next, content)
    step(meta.name)
  }
  await hidden.saveIndex(keepHiddenSettings ? { ...target.index, tags: [...new Set([...target.index.tags, ...source.index.tags])] } : source.index)
  step('Configurações')
  for (const device of await visible.listDevices()) await hidden.heartbeat(device)
  step('Dispositivos')
}

export async function differencesBetween(visible: DriveRepository, hidden: DriveRepository, checkSettings = true): Promise<string[]> {
  const [before, after] = await Promise.all([visible.load(), hidden.load()])
  const problems: string[] = []
  const copiedFolders = new Map(after.folders.map(folder => [folder.id, stable(folder)]))
  if (before.folders.some(folder => copiedFolders.get(folder.id) !== stable(folder))) problems.push('pastas')
  const [index, copiedIndex] = await Promise.all([visible.indexFromDrive(), hidden.indexFromDrive()])
  if (!index || !copiedIndex || (checkSettings && stable(index.settings) !== stable(copiedIndex.settings)) || index.tags.some(tag => !copiedIndex.tags.includes(tag))) problems.push('configurações')
  const copied = new Set(after.files.map(file => file.id))
  for (const meta of before.files) {
    if (!copied.has(meta.id)) {
      problems.push(`nota ${meta.name} não chegou`)
      continue
    }
    const [content, copiedContent, sidecar, copiedSidecar] = await Promise.all([visible.contentFromDrive(meta.id), hidden.contentFromDrive(meta.id), visible.sidecarFromDrive(meta.id), hidden.sidecarFromDrive(meta.id)])
    if (content === null || content !== copiedContent) problems.push(`texto de ${meta.name}`)
    if (!sidecar || !copiedSidecar) {
      problems.push(`dados de ${meta.name}`)
      continue
    }
    if (withoutSourceRef(sidecar) !== withoutSourceRef(copiedSidecar)) problems.push(`dados de ${meta.name}`)
    const stored = keepsSource(sidecar)
    const copiedRef = keepsSource(copiedSidecar)
    if (stored && (!copiedRef || visible.sourceChecksum(stored) !== hidden.sourceChecksum(copiedRef))) problems.push(`fonte de ${meta.name}`)
  }
  return problems
}

export async function openDriveLibrary(accountId: string, token: TokenProvider, report: MigrationReport): Promise<DriveLibrary> {
  const visible = new DriveRepository(accountId, token, 'drive')
  if (!(await hasAppDataAccessController(token))) return { repo: visible, hiddenPending: true, warning: null }
  const hidden = new DriveRepository(accountId, token, 'appDataFolder')
  const hasVisible = (repo: DriveRepository) =>
    repo.exists().catch(error => {
      if (error instanceof DriveError && error.status === 403) return false
      throw error
    })
  if (!(await hasVisible(visible))) return { repo: hidden, hiddenPending: false, warning: null }
  report('Copiando para a pasta oculta do Drive', 0)
  hidden.unlimited = true
  try {
    for (let pass = 0, source = visible; pass < MAX_VISIBLE_FOLDERS && (await hasVisible(source)); pass++, source = new DriveRepository(accountId, token, 'drive')) {
      await copyToHidden(source, hidden, report, pass > 0)
      report('Conferindo a cópia', null)
      const problems = await differencesBetween(source, hidden, pass === 0)
      if (problems.length) return { repo: source, hiddenPending: false, warning: `A cópia para a pasta oculta não bateu (${problems.slice(0, 3).join(', ')}); a pasta .sync-study-helper continua sendo usada e nada foi apagado.` }
      report('Apagando a pasta antiga', null)
      await source.removeEverything()
    }
    return { repo: hidden, hiddenPending: false, warning: null }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'erro desconhecido'
    return { repo: new DriveRepository(accountId, token, 'drive'), hiddenPending: false, warning: `A mudança para a pasta oculta parou (${reason}); a pasta .sync-study-helper continua sendo usada e o app tenta de novo na próxima vez.` }
  } finally {
    hidden.unlimited = false
  }
}
