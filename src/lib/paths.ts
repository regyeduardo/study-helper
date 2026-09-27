export const paths = {
  home: '/',
  library: '/biblioteca',
  folder: (id: string | null) => (id ? `/biblioteca/${id}` : '/biblioteca'),
  review: '/revisar',
  favorites: '/favoritos',
  trash: '/lixeira',
  file: (id: string) => `/arquivo/${id}`,
}

export type View = 'home' | 'folder' | 'review' | 'favorites' | 'trash' | 'doc'
