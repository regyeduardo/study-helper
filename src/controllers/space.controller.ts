import { apiCall } from '@/controllers/api.controller'

/** The space of the account in the App (spec 007, história 5; contracts/api-space.md), as the person and the owner see it. */
export interface AccountSpace {
  notes: number
  media: number
  trash: number
  reserved: number
  used: number
  limit: number
  free: number
  warnAt: number
  checkedAt: string | null
}

export interface LargeItem {
  id: string
  name: string
  kind: string
  noteType: string | null
  noteBytes: number
  mediaBytes: number
  trashed: boolean
  folderPath: string
}

export const getSpace = () => apiCall<AccountSpace>('GET', '/v1/space')
export const largestItems = async (): Promise<LargeItem[]> => (await apiCall<{ items: LargeItem[] }>('GET', '/v1/space/largest')).items
