import type { ArtifactKind, ShareKind } from '@/types/domain'
import { ApiError } from '@/controllers/api.controller'
import { send } from '@/controllers/library-api.controller'
import { env } from '@/lib/env'

/**
 * The live link of who uses the app structure (spec 003, história 7, contracts/api-compartilhar.md): only the pointer is kept in the
 * account; whoever opens the link reads the item from the App as it is now. No share-worker, no copy, no media sent again.
 */

export interface LiveLink {
  id: string
  itemId: string
  kind: ShareKind
  title: string
  live: true
  withExams: boolean
  artifacts: ArtifactKind[]
  createdAt: string
  /** spec 007 (história 4): the deadline chosen; `expiresAt` null = Permanente */
  expiresIn?: LinkDeadline
  expiresAt?: string | null
  expired?: boolean
  /** The address people copy and agents read (api…/s/<id>) */
  url?: string
  updatedAt?: string
}

/** The deadlines of a link (spec 007, FR-032): 1, 3 or 7 days, or Permanente. */
export type LinkDeadline = '1d' | '3d' | '7d' | 'never'

/** A note of the link as the App answers it: the row of the map and the parts that go in the link, already without what stays home. */
export interface LiveRow {
  id: string
  noteType: string | null
  name: string
  folderId: string | null
  parentFileId: string | null
  position: number
  meta: Record<string, unknown>
  createdAt: string
  updatedAt: string
  parts: Record<string, string>
  media: { mime: string; bytes: number } | null
}

export interface LiveFolder {
  id: string
  name: string
  parentId: string | null
  position: number
  meta: Record<string, unknown>
}

export interface LiveContent extends LiveLink {
  owner: { name: string }
  folders: LiveFolder[]
  files: LiveRow[]
}

/** The link of the item that is still on, from any device of the person (FR-035); null when there is none. */
export async function itemLiveLink(itemId: string): Promise<LiveLink | null> {
  try {
    return (await (await send('GET', `/v1/shares?item=${encodeURIComponent(itemId)}`)).json()) as LiveLink
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

export async function createLiveLink(request: { item: string; kind: ShareKind; withExams: boolean; artifacts: ArtifactKind[]; expiresIn?: LinkDeadline }): Promise<LiveLink> {
  return (await (await send('POST', '/v1/shares', { json: request })).json()) as LiveLink
}

/** "Mudar prazo" (spec 007, FR-033): counting from now, on the same address; an expired link opens again. */
export async function changeLiveDeadline(id: string, expiresIn: LinkDeadline): Promise<LiveLink> {
  return (await (await send('PATCH', `/v1/shares/${encodeURIComponent(id)}`, { json: { expiresIn } })).json()) as LiveLink
}

/** Every link of the person, with its deadline, the expired ones last (spec 007, FR-041). */
export async function myLiveLinks(): Promise<LiveLink[]> {
  return ((await (await send('GET', '/v1/shares')).json()) as { links: LiveLink[] }).links
}

/** "Parar de compartilhar" (FR-063): the link then says the item stopped being shared. */
export async function stopLiveLink(id: string): Promise<void> {
  await send('DELETE', `/v1/shares/${encodeURIComponent(id)}`)
}

export function liveMediaUrl(shareId: string, fileId: string): string {
  return `${env.apiUrl}/v1/shared/${encodeURIComponent(shareId)}/media/${encodeURIComponent(fileId)}`
}

/** Why a link of the App does not open (spec 007): expired, stopped, the item removed or out of the App. */
export interface LiveRefusal {
  gone: string
}

/** The link read from the App, without a session; `{ gone }` with the reason when it expired, was stopped or the item left; null when the App does not know it (a link of the share-worker). */
export async function fetchLiveContent(id: string): Promise<LiveContent | LiveRefusal | null> {
  try {
    const response = await fetch(`${env.apiUrl}/v1/shared/${encodeURIComponent(id)}`)
    if (response.status === 410) return { gone: String(((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'gone') }
    if (!response.ok) return null
    return (await response.json()) as LiveContent
  } catch {
    return null
  }
}
