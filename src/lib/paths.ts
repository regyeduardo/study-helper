export const paths = {
  home: '/',
  library: '/biblioteca',
  folder: (id: string | null) => (id ? `/biblioteca/${id}` : '/biblioteca'),
  review: '/revisar',
  favorites: '/favoritos',
  trash: '/lixeira',
  file: (id: string) => `/arquivo/${id}`,
  shares: '/compartilhados',
  sharedWithMe: '/compartilhados-comigo',
  shared: (id: string) => `/shared/${id}`,
  sharedFile: (id: string, fileId: string) => `/shared/${id}/${fileId}`,
}

export type View = 'home' | 'folder' | 'review' | 'favorites' | 'trash' | 'doc' | 'shares' | 'sharedWithMe' | 'shared'
