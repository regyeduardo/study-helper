import { createBrowserRouter } from 'react-router-dom'

import { lazy, type ReactNode, Suspense } from 'react'

import App from '@/App'
import { ADMIN_PATH } from '@/lib/paths'
import { marcarRotas } from '@/lib/perf-routes'
import WorkspacePage from '@/pages/workspace'

// spec 007 (research R6): Idiomas and the Administração load when first used, not with the app; preloadRoutes fetches them when the
// app is idle, so the first visit does not wait for them either
const loadAdmin = () => import('@/pages/admin')
const loadLanguages = () => import('@/pages/idiomas')
const loadLanguage = () => import('@/pages/idiomas/language')
const loadStudy = () => import('@/pages/idiomas/study')
// spec 007, história 2: the job page of the server, outside the app's frame
const WorkerPage = lazy(() => import('@/pages/trabalho'))
const AdminPage = lazy(loadAdmin)
const LanguagesPage = lazy(loadLanguages)
const LanguagePage = lazy(loadLanguage)
const StudyPage = lazy(loadStudy)

export function preloadRoutes(): void {
  for (const load of [loadLanguages, loadLanguage, loadStudy, loadAdmin]) void load().catch(() => undefined)
}

const later = (page: ReactNode) => <Suspense fallback={null}>{page}</Suspense>

export const router = createBrowserRouter(
  [
    { path: '/trabalho/:id', element: later(<WorkerPage />) },
    {
      element: <App />,
      children: [
        { path: '/', element: <WorkspacePage /> },
        { path: '/biblioteca', element: <WorkspacePage /> },
        { path: '/biblioteca/:folderId', element: <WorkspacePage /> },
        { path: '/revisar', element: <WorkspacePage /> },
        { path: '/favoritos', element: <WorkspacePage /> },
        { path: '/lixeira', element: <WorkspacePage /> },
        { path: '/arquivo/:fileId', element: <WorkspacePage /> },
        { path: '/gravacoes', element: <WorkspacePage /> },
        { path: '/entradas', element: <WorkspacePage /> },
        { path: '/entrada/:fileId', element: <WorkspacePage /> },
        { path: '/compartilhados', element: <WorkspacePage /> },
        { path: '/compartilhados-comigo', element: <WorkspacePage /> },
        { path: '/shared/:shareId', element: <WorkspacePage /> },
        { path: '/shared/:shareId/pasta/:folderId', element: <WorkspacePage /> },
        { path: '/shared/:shareId/arquivo/:fileId', element: <WorkspacePage /> },
        { path: '/idiomas', element: later(<LanguagesPage />) },
        { path: '/idiomas/:code', element: later(<LanguagePage />) },
        { path: '/idiomas/:code/area/:area', element: later(<StudyPage />) },
        { path: '/idiomas/:code/:textId', element: later(<StudyPage />) },
        { path: ADMIN_PATH, element: later(<AdminPage />) },
        { path: '*', element: <WorkspacePage /> },
      ],
    },
  ],
  { basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/' },
)

// spec 007: a screen change starts its measure when the address changes (only with the measures on)
marcarRotas(router)

// once the app has drawn and is idle, the pages that load later are fetched ahead (spec 007, R6)
if (typeof window !== 'undefined') {
  const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 2000))
  idle(() => preloadRoutes(), { timeout: 5000 })
}
