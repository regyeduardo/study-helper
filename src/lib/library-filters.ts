// Filtros combináveis das listas da biblioteca (FR-044, FR-045): E entre os grupos, OU dentro de cada grupo, com a contagem de cada opção.
import type { FileMeta, FileType, FolderMeta } from '@/types/domain'
import { descendantsOf, isNote } from '@/lib/family'
import { mediaOf } from '@/lib/file-types'

export type Scope = 'tudo' | 'entradas' | 'notas'
export type ItemKind = 'video' | 'audio' | 'pdf' | 'link' | 'texto' | 'tema' | 'arquivo' | 'nota'
export type Generated = 'ata' | 'aula' | 'explicacao' | 'leitura' | 'mapa' | 'cartoes' | 'tutor' | 'nada'
export type DateField = 'updated' | 'created'
export type PeriodPreset = 'hoje' | '7dias' | '30dias'
/** A preset, or the days of "Escolher datas…": YYYY-MM-DD, both inclusive, either may be missing. */
export type Period = PeriodPreset | { from?: string; to?: string }
export type Place = 'drive' | 'navegador' | 'temporario' | 'registro' | 'apagado'
export type FilterGroup = 'kinds' | 'generated' | 'period' | 'tags' | 'folders' | 'places'

export interface LibraryFilters {
  scope: Scope
  kinds: ItemKind[]
  generated: Generated[]
  /** The Atualizado/Criado switch: it stays when the period is cleared. */
  dateField: DateField
  period: Period | null
  tags: string[]
  /** `null` is the root of the library. */
  folders: (string | null)[]
  subfolders: boolean
  places: Place[]
}

export const NO_FILTERS: LibraryFilters = { scope: 'tudo', kinds: [], generated: [], dateField: 'updated', period: null, tags: [], folders: [], subfolders: true, places: [] }

export const GROUP_LABELS: Record<FilterGroup, string> = { kinds: 'Tipo', generated: 'O que gerou', period: 'Período', tags: 'Etiqueta', folders: 'Pasta', places: 'Guardado' }
export const SCOPE_LABELS: Record<Scope, string> = { tudo: 'Tudo', entradas: 'Entradas', notas: 'Notas' }
export const DATE_FIELD_LABELS: Record<DateField, string> = { updated: 'Atualizado', created: 'Criado' }

export interface PlaceContext {
  /** Ids of the items whose media is in Mídias, in this browser. */
  localMedia: ReadonlySet<string>
  /** Where the library itself lives: the Drive or, in the Local profile, this browser. */
  library: 'drive' | 'navegador'
  now: Date | number | string
}

export interface FilterSource {
  /** Everything, with the Lixeira: what is there never counts. */
  files: FileMeta[]
  folders: FolderMeta[]
  localMedia?: Iterable<string>
  library?: PlaceContext['library']
  now: PlaceContext['now']
  /** Settings' timezone: where "hoje" begins. */
  timeZone?: string
  /** The search hits, while searching: nothing else appears or is counted, but the total stays the library's. */
  only?: ReadonlySet<string> | null
}

export interface FacetOption<Id> {
  id: Id
  label: string
  count: number
  selected: boolean
}

export interface FolderOption extends FacetOption<string | null> {
  /** 0 for the root of the library, 1 for its folders, and so on. */
  depth: number
}

export interface Facets {
  kinds: FacetOption<ItemKind>[]
  generated: FacetOption<Generated>[]
  period: FacetOption<PeriodPreset>[]
  /** How many are in the chosen days; null when no days are chosen. */
  periodCustom: number | null
  tags: FacetOption<string>[]
  /** The live folders, in tree order. */
  folders: FolderOption[]
  /** "Com subpastas": how many are in the chosen folders and below them; null when no folder is chosen. */
  withSubfolders: number | null
  places: FacetOption<Place>[]
}

export interface ActiveFilter {
  group: FilterGroup
  label: string
  value: string
}

export interface FilterResult {
  /** What passes everything, in the order received. */
  items: FileMeta[]
  shown: number
  /** Everything alive in the library. */
  total: number
  /** "8 de 214" */
  summary: string
  scopes: Record<Scope, number>
  facets: Facets
  active: ActiveFilter[]
}

interface Option<Id> {
  id: Id
  label: string
  /** Inside the chip of the active filter. */
  chip: string
}

const KINDS: Option<ItemKind>[] = [
  { id: 'video', label: 'Vídeo', chip: 'vídeo' },
  { id: 'audio', label: 'Áudio', chip: 'áudio' },
  { id: 'pdf', label: 'PDF', chip: 'PDF' },
  { id: 'link', label: 'Link', chip: 'link' },
  { id: 'texto', label: 'Texto', chip: 'texto' },
  { id: 'tema', label: 'Tema', chip: 'tema' },
  { id: 'arquivo', label: 'Outro arquivo', chip: 'outro arquivo' },
  { id: 'nota', label: 'Nota', chip: 'nota' },
]

const GENERATED: Option<Generated>[] = [
  { id: 'ata', label: 'Ata', chip: 'ata' },
  { id: 'aula', label: 'Aula', chip: 'aula' },
  { id: 'explicacao', label: 'Explicação', chip: 'explicação' },
  { id: 'leitura', label: 'Leitura', chip: 'leitura' },
  { id: 'mapa', label: 'Mapa', chip: 'mapa' },
  { id: 'cartoes', label: 'Cartões', chip: 'cartões' },
  { id: 'tutor', label: 'Conversa do Tutor', chip: 'conversa do Tutor' },
  { id: 'nada', label: 'Nada ainda', chip: 'nada ainda' },
]

const PRESETS: (Option<PeriodPreset> & { daysBack: number })[] = [
  { id: 'hoje', label: 'Hoje', chip: 'hoje', daysBack: 0 },
  { id: '7dias', label: 'Últimos 7 dias', chip: '7 dias', daysBack: 6 },
  { id: '30dias', label: 'Últimos 30 dias', chip: '30 dias', daysBack: 29 },
]

const PLACES: Option<Place>[] = [
  { id: 'drive', label: 'No meu Drive', chip: 'no meu Drive' },
  { id: 'navegador', label: 'Só neste navegador', chip: 'só neste navegador' },
  { id: 'temporario', label: 'Temporário', chip: 'temporário' },
  { id: 'registro', label: 'Só o registro', chip: 'só o registro' },
  { id: 'apagado', label: 'Mídia apagada', chip: 'mídia apagada' },
]

const NOTE_GENERATED: Record<FileType, Generated> = { meeting: 'ata', class: 'aula', explanation: 'explicacao', reading: 'leitura' }

const ROOT_LABEL = 'Biblioteca'
const MAX_DEPTH = 64

/* ---------- what each item is ---------- */

export function kindOf(file: FileMeta): ItemKind {
  if (isNote(file)) return 'nota'
  const origin = file.origin
  if (!origin) return 'texto'
  if (origin.input === 'youtube') return 'video'
  if (origin.input === 'url') return 'link'
  if (origin.input === 'topic') return 'tema'
  if (origin.input === 'text') return 'texto'
  const media = mediaOf(file)
  if (media !== 'text') return media
  return origin.mime === 'application/pdf' || /\.pdf$/i.test(origin.name) ? 'pdf' : 'arquivo'
}

/** Where it is kept now. A note is where the library is, unless its media is only here; `storage: 'drive'` means the library's own store. */
export function placeOf(file: FileMeta, { localMedia, library, now }: PlaceContext): Place {
  const here = localMedia.has(file.id)
  const origin = file.origin
  const addressed = origin?.storage === 'drive' && Boolean(origin.storedFileId)
  if (isNote(file)) return here && !addressed ? 'navegador' : library
  if (origin?.removedAt) return 'apagado'
  if (addressed) return library
  const hosted = Boolean(origin?.storedUrl && origin.storage !== 'none' && origin.storage !== 'drive')
  if (hosted && !(origin?.expiresAt && Date.parse(origin.expiresAt) < new Date(now).getTime())) return 'temporario'
  if (here) return 'navegador'
  // a file was kept and has no address: it is in the Mídias of the browser that kept it
  if (file.kept === 'arquivo' && !origin?.storedFileId && !origin?.storedUrl) return 'navegador'
  return 'registro'
}

function generatedOf(files: FileMeta[], file: FileMeta, isLive: (item: FileMeta) => boolean): Set<Generated> {
  const family = descendantsOf(files, file.id).filter(isLive)
  const found = new Set<Generated>()
  for (const item of family) if (isNote(item)) found.add(NOTE_GENERATED[item.type])
  for (const item of [file, ...family]) {
    for (const artifact of item.artifacts ?? []) found.add(artifact.kind)
    if (item.hasMindmap) found.add('mapa')
    if (item.cardDue?.length) found.add('cartoes')
  }
  return found
}

/* ---------- days, in the person's timezone ---------- */

const dayFormats = new Map<string, Intl.DateTimeFormat>()

function dayOf(at: Date | number | string, timeZone: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  let format = dayFormats.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    dayFormats.set(timeZone, format)
  }
  const parts = Object.fromEntries(format.formatToParts(date).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function daysBefore(day: string, count: number): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() - count)
  return date.toISOString().slice(0, 10)
}

const brazilianDay = (day: string) => day.split('-').reverse().join('/')

/** The chosen days, in order; null when no day was chosen. */
function daysOf(period: Period | null): { from?: string; to?: string } | null {
  if (!period || typeof period === 'string' || (!period.from && !period.to)) return null
  const { from, to } = period
  return from && to && from > to ? { from: to, to: from } : { from: from || undefined, to: to || undefined }
}

const isActivePeriod = (period: Period | null): period is Period => typeof period === 'string' || daysOf(period) !== null

/* ---------- folders ---------- */

/** Each live folder and the folders above it, itself first. Same rule as `liveFolders`: a folder under one in the Lixeira is in the Lixeira. */
function liveChains(folders: FolderMeta[]): Map<string, string[]> {
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const chains = new Map<string, string[]>()
  for (const folder of folders) {
    const chain: string[] = []
    let alive = true
    let current: FolderMeta | undefined = folder
    for (let depth = 0; current && depth < MAX_DEPTH && !chain.includes(current.id); depth++) {
      if (current.deletedAt) {
        alive = false
        break
      }
      chain.push(current.id)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    if (alive) chains.set(folder.id, chain)
  }
  return chains
}

function folderTree(folders: FolderMeta[], chains: Map<string, string[]>): { id: string | null; label: string; depth: number }[] {
  const live = folders.filter(folder => chains.has(folder.id))
  const known = new Set(live.map(folder => folder.id))
  const children = new Map<string | null, FolderMeta[]>()
  for (const folder of live) {
    const parent = folder.parentId && known.has(folder.parentId) ? folder.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), folder])
  }
  const tree: { id: string | null; label: string; depth: number }[] = [{ id: null, label: ROOT_LABEL, depth: 0 }]
  const walk = (parent: string | null, depth: number) => {
    if (depth > MAX_DEPTH) return
    for (const folder of [...(children.get(parent) ?? [])].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'pt-BR'))) {
      tree.push({ id: folder.id, label: folder.name, depth })
      walk(folder.id, depth + 1)
    }
  }
  walk(null, 1)
  return tree
}

/* ---------- the chips ---------- */

function chipsOf<Id>(options: Option<Id>[], selected: readonly Id[]): string {
  return options
    .filter(option => selected.includes(option.id))
    .map(option => option.chip)
    .join(', ')
}

function periodChip(period: Period): string {
  if (typeof period === 'string') return PRESETS.find(preset => preset.id === period)!.chip
  const { from, to } = daysOf(period)!
  if (from && to) return `${brazilianDay(from)} a ${brazilianDay(to)}`
  return from ? `desde ${brazilianDay(from)}` : `até ${brazilianDay(to!)}`
}

function activeFilters(filters: LibraryFilters, folders: FolderMeta[]): ActiveFilter[] {
  const active: ActiveFilter[] = []
  const add = (group: FilterGroup, value: string, label = GROUP_LABELS[group]) => active.push({ group, label, value })
  if (filters.kinds.length) add('kinds', chipsOf(KINDS, filters.kinds))
  if (filters.generated.length) add('generated', chipsOf(GENERATED, filters.generated))
  if (isActivePeriod(filters.period)) add('period', periodChip(filters.period), DATE_FIELD_LABELS[filters.dateField])
  if (filters.tags.length) add('tags', [...filters.tags].sort((a, b) => a.localeCompare(b, 'pt-BR')).join(', '))
  if (filters.folders.length) {
    const nameOf = (id: string | null) => (id === null ? ROOT_LABEL : (folders.find(folder => folder.id === id)?.name ?? 'pasta apagada'))
    add('folders', `${filters.folders.map(nameOf).join(', ')}${filters.subfolders ? ' e subpastas' : ''}`)
  }
  if (filters.places.length) add('places', chipsOf(PLACES, filters.places))
  return active
}

/* ---------- the filter ---------- */

type Group = 'scope' | FilterGroup

interface Facts {
  file: FileMeta
  note: boolean
  kind: ItemKind
  generated: Set<Generated>
  day: string
  /** The folder and those above it; empty at the root. */
  chain: string[]
  place: Place
}

function tally<Id>(counts: Map<Id, number>, id: Id): void {
  counts.set(id, (counts.get(id) ?? 0) + 1)
}

function facetOf<Id>(options: Pick<Option<Id>, 'id' | 'label'>[], counts: Map<Id, number>, selected: readonly Id[]): FacetOption<Id>[] {
  return options.map(({ id, label }) => ({ id, label, count: counts.get(id) ?? 0, selected: selected.includes(id) }))
}

/** Applies the filters and counts each option against the other active groups. Pure: memoize on its inputs. */
export function filterLibrary(source: FilterSource, filters: LibraryFilters): FilterResult {
  const { files, folders, only } = source
  const timeZone = source.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const where: PlaceContext = { localMedia: new Set(source.localMedia ?? []), library: source.library ?? 'drive', now: source.now }
  const chains = liveChains(folders)
  const isLive = (file: FileMeta) => !file.deletedAt && (file.folderId === null || chains.has(file.folderId))

  const facts = files.filter(isLive).map(
    (file): Facts => ({
      file,
      note: isNote(file),
      kind: kindOf(file),
      generated: generatedOf(files, file, isLive),
      day: dayOf(filters.dateField === 'created' ? file.created.at : file.updated.at, timeZone),
      chain: file.folderId ? (chains.get(file.folderId) ?? []) : [],
      place: placeOf(file, where),
    }),
  )

  const today = dayOf(source.now, timeZone)
  const startOf = new Map(PRESETS.map(preset => [preset.id, daysBefore(today, preset.daysBack)]))
  const days = daysOf(filters.period)
  const inPreset = (day: string, preset: PeriodPreset) => Boolean(day) && day >= startOf.get(preset)!
  const inDays = (day: string) => Boolean(day && days) && (!days!.from || day >= days!.from) && (!days!.to || day <= days!.to)

  const chosenFolders = new Set(filters.folders)
  const belowChosen = ({ chain }: Facts) => chosenFolders.has(null) || chain.some(id => chosenFolders.has(id))
  const generatedMatches = ({ generated }: Facts) => (generated.size ? [...generated].some(item => filters.generated.includes(item)) : filters.generated.includes('nada'))

  const passes: Record<Group, (item: Facts) => boolean> = {
    scope: item => filters.scope === 'tudo' || item.note === (filters.scope === 'notas'),
    kinds: item => !filters.kinds.length || filters.kinds.includes(item.kind),
    generated: item => !filters.generated.length || generatedMatches(item),
    period: item => (typeof filters.period === 'string' ? inPreset(item.day, filters.period) : !days || inDays(item.day)),
    tags: item => !filters.tags.length || item.file.tags.some(tag => filters.tags.includes(tag)),
    folders: item => !chosenFolders.size || (filters.subfolders ? belowChosen(item) : chosenFolders.has(item.file.folderId)),
    places: item => !filters.places.length || filters.places.includes(item.place),
  }
  const groups = Object.keys(passes) as Group[]

  // An item failing one group still counts for that group's options; failing two, for none.
  const shown: FileMeta[] = []
  const countedFor = new Map<Group, Facts[]>(groups.map(group => [group, []]))
  for (const item of facts) {
    if (only && !only.has(item.file.id)) continue
    const failed = groups.filter(group => !passes[group](item))
    if (failed.length > 1) continue
    if (!failed.length) shown.push(item.file)
    for (const group of failed.length ? failed : groups) countedFor.get(group)!.push(item)
  }

  const scopes: Record<Scope, number> = { tudo: 0, entradas: 0, notas: 0 }
  for (const item of countedFor.get('scope')!) {
    scopes.tudo++
    scopes[item.note ? 'notas' : 'entradas']++
  }

  const kindCounts = new Map<ItemKind, number>()
  for (const item of countedFor.get('kinds')!) tally(kindCounts, item.kind)

  const generatedCounts = new Map<Generated, number>()
  for (const item of countedFor.get('generated')!) {
    if (!item.generated.size) tally(generatedCounts, 'nada')
    for (const generated of item.generated) tally(generatedCounts, generated)
  }

  const presetCounts = new Map<PeriodPreset, number>()
  let periodCustom = days ? 0 : null
  for (const item of countedFor.get('period')!) {
    for (const preset of PRESETS) if (inPreset(item.day, preset.id)) tally(presetCounts, preset.id)
    if (periodCustom !== null && inDays(item.day)) periodCustom++
  }

  const tagCounts = new Map<string, number>()
  for (const item of countedFor.get('tags')!) for (const tag of new Set(item.file.tags)) tally(tagCounts, tag)
  const tagNames = [...new Set([...facts.flatMap(item => item.file.tags), ...filters.tags])].sort((a, b) => a.localeCompare(b, 'pt-BR'))

  const folderCounts = new Map<string | null, number>()
  let withSubfolders = chosenFolders.size ? 0 : null
  for (const item of countedFor.get('folders')!) {
    if (filters.subfolders) {
      tally(folderCounts, null)
      for (const id of item.chain) tally(folderCounts, id)
    } else tally(folderCounts, item.file.folderId)
    if (withSubfolders !== null && belowChosen(item)) withSubfolders++
  }

  const placeCounts = new Map<Place, number>()
  for (const item of countedFor.get('places')!) tally(placeCounts, item.place)

  return {
    items: shown,
    shown: shown.length,
    total: facts.length,
    summary: `${shown.length} de ${facts.length}`,
    scopes,
    facets: {
      kinds: facetOf(KINDS, kindCounts, filters.kinds),
      generated: facetOf(GENERATED, generatedCounts, filters.generated),
      period: facetOf(PRESETS, presetCounts, typeof filters.period === 'string' ? [filters.period] : []),
      periodCustom,
      tags: facetOf(tagNames.map(tag => ({ id: tag, label: tag })), tagCounts, filters.tags),
      folders: folderTree(folders, chains).map(({ id, label, depth }) => ({ id, label, depth, count: folderCounts.get(id) ?? 0, selected: chosenFolders.has(id) })),
      withSubfolders,
      places: facetOf(PLACES, placeCounts, filters.places),
    },
    active: activeFilters(filters, folders),
  }
}

/* ---------- changing the filters ---------- */

const CLEARED: Record<FilterGroup, Partial<LibraryFilters>> = {
  kinds: { kinds: [] },
  generated: { generated: [] },
  period: { period: null },
  tags: { tags: [] },
  folders: { folders: [], subfolders: true },
  places: { places: [] },
}

/** The "x" of an active filter: takes its whole group out. */
export function withoutFilter(filters: LibraryFilters, group: FilterGroup): LibraryFilters {
  return { ...filters, ...CLEARED[group] }
}

/** "Limpar tudo": the tab (Tudo, Entradas, Notas) and the Atualizado/Criado switch are not filters, and stay. */
export function clearFilters(filters: LibraryFilters): LibraryFilters {
  return { ...NO_FILTERS, scope: filters.scope, dateField: filters.dateField }
}

type ListGroup = 'kinds' | 'generated' | 'tags' | 'folders' | 'places'

/** Checks or unchecks an option of a group that takes several. */
export function toggleOption<G extends ListGroup>(filters: LibraryFilters, group: G, id: LibraryFilters[G][number]): LibraryFilters {
  const list = filters[group] as readonly unknown[]
  return { ...filters, [group]: list.includes(id) ? list.filter(item => item !== id) : [...list, id] }
}
