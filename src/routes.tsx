import { createBrowserRouter } from 'react-router-dom'

import App from '@/App'
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
        { path: '*', element: <WorkspacePage /> },
      ],
    },
  ],
  { basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/' },
)
