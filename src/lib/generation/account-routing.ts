import { mediaOf } from '@/lib/file-types'
import { useLibraryStore } from '@/stores/library'

/**
 * When a generation goes to the account (spec 007, história 2, research R10b, FR-010 and FR-017): with the structure on, internet,
 * and a note kept in the App (with its media in the App, when it has one), the server runs it; otherwise it runs on this device as
 * before: no structure, a note in the Google Drive or in Local, a call with a file in hand, no internet. On the server's own job page
 * nothing is sent back to the account (it would go round forever).
 */

let workerMode = false

/** On the job page of the server: every call runs right there. */
export function setWorkerMode(on: boolean): void {
  workerMode = on
}

type Pick = (args: unknown[]) => string | null
const first: Pick = args => (typeof args[0] === 'string' ? args[0] : null)

/** The calls that may go to the account, and the note each one starts from. */
export const ROUTED_CALLS: Record<string, Pick> = {
  generateFromNote: first,
  generateAta: first,
  generatePending: first,
  generateSecondTab: first,
  redoTranscript: first,
  transcribeNote: first,
  createQuestions: first,
  regenerate: first,
  suggestTags: first,
  explainSelection: first,
  generateFromSelection: first,
  generateArtifact: args => (args[0] && typeof args[0] === 'object' && typeof (args[0] as { fileId?: unknown }).fileId === 'string' ? (args[0] as { fileId: string }).fileId : null),
  // a course folder: its lessons are born in the App
  generateRemaining: () => null,
}

const LABELS: Record<string, string> = {
  generateFromNote: 'Gerando',
  generateAta: 'Ata',
  generatePending: 'Aula',
  generateSecondTab: 'Gerando',
  redoTranscript: 'Refazendo a transcrição',
  transcribeNote: 'Transcrição',
  createQuestions: 'Prova',
  regenerate: 'Gerando de novo',
  suggestTags: 'Etiquetas',
  explainSelection: 'Explicação',
  generateFromSelection: 'Gerando',
  generateArtifact: 'Mapa ou cartões',
  generateRemaining: 'Aulas do curso',
}

const isFile = (value: unknown) => typeof Blob !== 'undefined' && value instanceof Blob

/** The note a call starts from and the title of its job, when the call goes to the account; null when it runs here. */
export function routeOf(call: string, args: unknown[]): { fileId: string | null; title: string } | null {
  if (workerMode) return null
  const pick = ROUTED_CALLS[call]
  if (!pick) return null
  const library = useLibraryStore.getState()
  if (!library.appOn || library.sharedView) return null
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null
  if (args.some(arg => isFile(arg) || (arg && typeof arg === 'object' && Object.values(arg as object).some(isFile)))) return null
  const fileId = pick(args)
  const label = LABELS[call] ?? 'Gerando'
  if (!fileId) return { fileId: null, title: label }
  const repo = library.repo as { sideOf?: (id: string) => string | undefined } | null
  if (!repo?.sideOf || repo.sideOf(fileId) !== 'app') return null
  const meta = library.files.find(file => file.id === fileId)
  if (!meta) return null
  const origin = meta.origin
  const inApp = (origin?.storedFileId ?? '').startsWith('app:')
  // a media kept only in this browser is heard here (a recording saved to the App keeps its copy here too: the App has it)
  if (!inApp && library.localMedia.some(item => item.fileIds.includes(fileId))) return null
  // a media that is not in the App (only in this browser, in the Drive, in a temporary service) is heard here, as before
  if (origin && mediaOf(meta) !== 'text' && origin.storage !== 'none' && !inApp) return null
  return { fileId, title: `${label} · ${meta.name}` }
}
