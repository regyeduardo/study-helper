let sharedRoot: string | null = null

export function setSharedRoot(shareId: string | null) {
  sharedRoot = shareId ? `/shared/${shareId}` : null
}

/** Where the Administração lives; the account menu links here only for the admin account (here, so the routes need not load the page). */
export const ADMIN_PATH = '/administracao'

export const paths = {
  home: '/',
  library: '/biblioteca',
  folder: (id: string | null) => (sharedRoot ? (id ? `${sharedRoot}/pasta/${id}` : sharedRoot) : id ? `/biblioteca/${id}` : '/biblioteca'),
  review: '/revisar',
  favorites: '/favoritos',
  trash: '/lixeira',
  file: (id: string) => (sharedRoot ? `${sharedRoot}/arquivo/${id}` : `/arquivo/${id}`),
  /** Gravações (was "Entradas"; the old address still opens it). */
  entries: '/gravacoes',
  entry: (id: string) => `/entrada/${id}`,
  /** Gerações (FR-065): what the AI is making, what failed and what came out. */
  generations: '/geracoes',
  shares: '/compartilhados',
  sharedWithMe: '/compartilhados-comigo',
  shared: (id: string) => `/shared/${id}`,
  /** Idiomas (spec 004): the languages, each one's page and the study of a text. */
  languages: '/idiomas',
  language: (code: string) => `/idiomas/${encodeURIComponent(code)}`,
  study: (code: string, textId: string) => `/idiomas/${encodeURIComponent(code)}/${encodeURIComponent(textId)}`,
}

export type View = 'home' | 'folder' | 'review' | 'favorites' | 'trash' | 'doc' | 'entries' | 'entry' | 'generations' | 'shares' | 'sharedWithMe' | 'shared' | 'languages'
