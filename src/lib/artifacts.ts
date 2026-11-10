// Artefatos de uma nota (mapas, baralhos, conversas do Tutor): the list in the sidecar and its summary in the meta.
import type { Artifact, ArtifactKind, ArtifactSummary, CardsArtifact, FileMeta, FileSidecar, GenerationChoice, MapArtifact, MapDiagram, MindNode, StudyCard, TutorArtifact } from '@/types/domain'
import { mapFromOld } from '@/lib/generation/mindmap'
import { newId, nowIso } from '@/lib/ids'

const PLACEHOLDERS: Record<ArtifactKind, string> = { mapa: 'Mapa mental', cartoes: 'Cartões', tutor: 'Conversa' }
const QUESTION_NAME_CHARS = 60

export function placeholderName(kind: ArtifactKind): string {
  return PLACEHOLDERS[kind]
}

const two = (value: number) => String(value).padStart(2, '0')

/** "<Tipo> · dd/mm hh:mm", in this device's time: the name of a new artifact the AI did not name. */
function fallbackName(kind: ArtifactKind, at: string): string {
  const date = new Date(at)
  return `${placeholderName(kind)} · ${two(date.getDate())}/${two(date.getMonth() + 1)} ${two(date.getHours())}:${two(date.getMinutes())}`
}

export function summaryOf(artifact: Artifact): ArtifactSummary {
  return { id: artifact.id, kind: artifact.kind, name: artifact.name, updatedAt: artifact.updatedAt }
}

export function decksOf(list: Artifact[], deckId?: string): CardsArtifact[] {
  return list.filter((item): item is CardsArtifact => item.kind === 'cartoes' && (!deckId || item.id === deckId))
}

type OfKind<K extends ArtifactKind> = Extract<Artifact, { kind: K }>

/** The one of that kind changed last (ties: the later in the list). */
export function latestOf<K extends ArtifactKind>(list: Artifact[], kind: K): OfKind<K> | null {
  return list.filter((item): item is OfKind<K> => item.kind === kind).reduce<OfKind<K> | null>((last, item) => (!last || item.updatedAt >= last.updatedAt ? item : last), null)
}

export function dueOfDecks(list: Artifact[]): string[] {
  return decksOf(list).flatMap(deck => deck.cards.map(card => card.due))
}

/** What the library keeps in the note's meta so it knows the artifacts without opening the note. */
export function artifactMeta(list: Artifact[]): Required<Pick<FileMeta, 'artifacts' | 'cardDue' | 'hasMindmap'>> {
  return { artifacts: list.map(summaryOf), cardDue: dueOfDecks(list), hasMindmap: list.some(item => item.kind === 'mapa') }
}

/* ---------- the old single map and deck ---------- */

/** FNV-1a: the same old map or deck gets the same id on every device, so a sync merge does not double it. */
function hashOf(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193)
  return (hash >>> 0).toString(36)
}

const oldMapId = (map: MindNode) => `mapa-antigo-${hashOf(JSON.stringify(map))}`
// By the card ids only: reviewing the old cards does not make them another deck.
const oldDeckId = (cards: StudyCard[]) => `cartoes-antigos-${hashOf(cards.map(card => card.id).join(','))}`

function oldArtifacts(sidecar: FileSidecar): Artifact[] {
  const at = sidecar.meta.updated.at
  const kept = { provisionalName: true, createdAt: at, updatedAt: at }
  const list: Artifact[] = []
  if (sidecar.mindmap) list.push({ id: oldMapId(sidecar.mindmap), kind: 'mapa', name: placeholderName('mapa'), ...kept, diagram: mapFromOld(sidecar.mindmap), versions: [], chat: [] })
  if (sidecar.cards?.length) list.push({ id: oldDeckId(sidecar.cards), kind: 'cartoes', name: placeholderName('cartoes'), ...kept, cards: sidecar.cards })
  return list
}

/** The note's artifacts; the old `mindmap` and `cards`, while still there, come in as the first map and deck. */
export function artifactsOf(sidecar: FileSidecar): Artifact[] {
  const list = sidecar.artifacts ?? []
  const ids = new Set(list.map(item => item.id))
  const old = oldArtifacts(sidecar).filter(item => !ids.has(item.id))
  return old.length ? [...list, ...old] : list
}

export function hasOldFields(sidecar: FileSidecar): boolean {
  return sidecar.mindmap !== undefined || sidecar.cards !== undefined
}

function withList(sidecar: FileSidecar, list: Artifact[]): FileSidecar {
  return { ...sidecar, artifacts: list, meta: { ...sidecar.meta, ...artifactMeta(list) } }
}

function withoutOldWhere(sidecar: FileSidecar, gone: (migratedId: string) => boolean): FileSidecar {
  const { cards, mindmap, ...rest } = sidecar
  const dropCards = cards !== undefined && (!cards.length || gone(oldDeckId(cards)))
  const dropMap = mindmap !== undefined && gone(oldMapId(mindmap))
  if (!dropCards && !dropMap) return sidecar
  return { ...rest, ...(cards && !dropCards ? { cards } : {}), ...(mindmap && !dropMap ? { mindmap } : {}) }
}

/** First step of the migration: the list written with the old fields still there. */
export function migrated(sidecar: FileSidecar): FileSidecar {
  return withList(sidecar, artifactsOf(sidecar))
}

/** Second step: an old field goes only when its artifact is already in the saved list. */
export function withoutOldFields(sidecar: FileSidecar): FileSidecar {
  const saved = new Set((sidecar.artifacts ?? []).map(item => item.id))
  return withoutOldWhere(sidecar, id => saved.has(id))
}

/* ---------- changes ---------- */

/** A placeholder never takes the place of a name already given (a copy opened before the AI named it). */
function keptName(next: Artifact, was: Artifact): Artifact {
  return next.provisionalName && !was.provisionalName ? { ...next, name: was.name, provisionalName: false } : next
}

/** "Substituir este" starts over: the map keeps neither the conversation nor the versions of the one it replaces. */
function startedOver(artifact: Artifact): Artifact {
  if (artifact.kind !== 'mapa') return artifact
  const { highlight: _gone, ...map } = artifact
  return { ...map, versions: [], chat: [] }
}

/** Adds the artifact, or updates the one with its id; with `replaceId` it takes that one's place and id ("Substituir este"). */
export function withArtifact(sidecar: FileSidecar, artifact: Artifact, replaceId?: string): FileSidecar {
  const list = artifactsOf(sidecar)
  const id = replaceId ?? artifact.id
  const at = list.findIndex(item => item.id === id)
  if (at < 0) return withList(sidecar, [...list, artifact])
  const next = replaceId ? startedOver(artifact) : artifact
  return withList(
    sidecar,
    list.map((item, index) => (index === at ? keptName({ ...next, id }, item) : item)),
  )
}

export function renameArtifact(sidecar: FileSidecar, id: string, name: string): FileSidecar {
  const said = name.trim()
  const list = artifactsOf(sidecar)
  if (!said || !list.some(item => item.id === id)) return sidecar
  return withList(
    sidecar,
    list.map(item => (item.id === id ? { ...item, name: said, provisionalName: false } : item)),
  )
}

/** Also drops the old field it came from, so a deleted first map or deck does not come back. */
export function removeArtifact(sidecar: FileSidecar, id: string): FileSidecar {
  const list = artifactsOf(sidecar)
  if (!list.some(item => item.id === id)) return sidecar
  return withoutOldWhere(
    withList(
      sidecar,
      list.filter(item => item.id !== id),
    ),
    migratedId => migratedId === id,
  )
}

/* ---------- new ones ---------- */

interface Fields {
  name?: string | null
  made?: GenerationChoice
}

function baseOf<K extends ArtifactKind>(kind: K, { name, made }: Fields) {
  const said = name?.trim() ?? ''
  const now = nowIso()
  return { id: newId(), kind, name: said || fallbackName(kind, now), ...(said ? {} : { provisionalName: true }), createdAt: now, updatedAt: now, ...(made ? { made } : {}) }
}

export function newMapArtifact(fields: Fields & { diagram: MapDiagram }): MapArtifact {
  return { ...baseOf('mapa', fields), diagram: fields.diagram, versions: [], chat: [] }
}

export function newCardsArtifact(fields: Fields & { cards: StudyCard[] }): CardsArtifact {
  return { ...baseOf('cartoes', fields), cards: fields.cards }
}

/** The plain words of a question, short: the name of a conversation. */
export function questionName(text = ''): string {
  const plain = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > QUESTION_NAME_CHARS ? `${plain.slice(0, QUESTION_NAME_CHARS).replace(/\s+\S*$/, '')}…` : plain
}

export function newTutorArtifact({ turns = [], made }: { turns?: TutorArtifact['turns']; made?: GenerationChoice }): TutorArtifact {
  return { ...baseOf('tutor', { name: questionName(turns[0]?.text), made }), turns }
}
