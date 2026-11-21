import { createBrowserRouter } from 'react-router-dom'

import App from '@/App'
import AdminPage, { ADMIN_PATH } from '@/pages/admin'
import WorkspacePage from '@/pages/workspace'

export const router = createBrowserRouter(
  [
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
        { path: ADMIN_PATH, element: <AdminPage /> },
        { path: '*', element: <WorkspacePage /> },
      ],
    },
  ],
  { basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/' },
)
