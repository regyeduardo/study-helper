let sharedRoot: string | null = null

export function setSharedRoot(shareId: string | null) {
  sharedRoot = shareId ? `/shared/${shareId}` : null
}

export const paths = {
  home: '/',
  library: '/biblioteca',
  folder: (id: string | null) => (sharedRoot ? (id ? `${sharedRoot}/pasta/${id}` : sharedRoot) : id ? `/biblioteca/${id}` : '/biblioteca'),
  review: '/revisar',
  favorites: '/favoritos',
  trash: '/lixeira',
  file: (id: string) => (sharedRoot ? `${sharedRoot}/arquivo/${id}` : `/arquivo/${id}`),
  shares: '/compartilhados',
  sharedWithMe: '/compartilhados-comigo',
  shared: (id: string) => `/shared/${id}`,
}

export type View = 'home' | 'folder' | 'review' | 'favorites' | 'trash' | 'doc' | 'shares' | 'sharedWithMe' | 'shared'
