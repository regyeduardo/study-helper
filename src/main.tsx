import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'

import { keepAppOffline } from '@/lib/storage/media-stream'
import { applyTheme } from '@/lib/theme'
import { watchVisualViewport } from '@/lib/viewport'
import { router } from '@/routes'
import { useAccountStore } from '@/stores/account'
import { useUiStore } from '@/stores/ui'
import '@/styles/app.css'
import '@/styles/phone.css'

applyTheme()
watchVisualViewport()
keepAppOffline()

// Back from a Google sign-in made in this same tab (the road iPhone uses): finish it and return to where the person was.
void useAccountStore
  .getState()
  .finishRedirectLogin()
  .then(done => {
    if (!done) return
    void router.navigate(done.returnTo, { replace: true })
    if (done.message) useUiStore.getState().toast(done.message)
    else if (done.sendLocal) useUiStore.getState().open({ kind: 'send-local' })
  })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)
