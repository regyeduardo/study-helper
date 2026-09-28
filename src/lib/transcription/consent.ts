import { installedModels, type ModelId } from '@/lib/storage/installed-models'

export interface ModelDownload {
  id: ModelId
  name: string
  megabytes: number
}

type Asker = (downloads: ModelDownload[]) => Promise<boolean>

let asker: Asker | null = null

export class ModelDownloadDeclined extends Error {}

export function setModelDownloadAsker(next: Asker | null): void {
  asker = next
}

export function modelsNeeded(engine: 'whisper' | 'parakeet' | null, language: string, separateSpeakers: boolean): ModelDownload[] {
  const needed: ModelDownload[] = []
  if (engine === 'whisper') needed.push({ id: 'whisper', name: 'Whisper', megabytes: 515 })
  if (engine === 'parakeet') needed.push({ id: 'parakeet', name: language.startsWith('pt') ? 'Parakeet pt-BR' : 'Parakeet', megabytes: language.startsWith('pt') ? 930 : 670 })
  if (separateSpeakers) needed.push({ id: 'speakers', name: 'Separação de quem falou', megabytes: 34 })
  return needed
}

export async function confirmModelDownloads(needed: ModelDownload[]): Promise<void> {
  if (!asker || !needed.length) return
  const installed = new Set((await installedModels().catch(() => [])).map(model => model.id))
  const missing = needed.filter(model => !installed.has(model.id))
  if (missing.length && !(await asker(missing))) throw new ModelDownloadDeclined('A transcrição foi cancelada: o modelo não foi baixado.')
}
