// "Salvar no meu Drive" (FR-043): what is kept only in this browser says so, wherever it appears, and offers the Drive.
// With the app structure on, a note offers the App instead (its default place, spec 005 FR-006): the note and its media go there.
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'

import type { FileMeta } from '@/types/domain'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { preloadGoogleAccounts } from '@/controllers/google-auth.controller'
import { blocking } from '@/lib/blocking'
import { isNote } from '@/lib/family'
import { placeOf } from '@/lib/library-filters'
import type { LocalMedia } from '@/lib/recording/media-library'
import { saveLocalMediaToDrive, saveToDrive } from '@/lib/storage/source-storage'
import { UploadCancelled, watchedUpload } from '@/lib/storage/uploads'
import { useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { sideOfItem, usePlacesStore } from '@/stores/places'
import { useUiStore } from '@/stores/ui'
import '@/styles/save-to-drive.css'
import { formatBytes } from '@/utils/format'

const NOTICE = 'Só neste navegador'
const ACTION = 'Salvar no meu Drive'
const SAVING = 'Salvando no Drive…'
const RISK = 'Hoje este arquivo está só neste navegador: se os dados do navegador forem limpos, ele se perde. No Drive, ele fica na sua conta, disponível em qualquer aparelho.'
const SAVED = 'Salvo no seu Drive. Agora ele está disponível em qualquer aparelho.'
const NEW_ENTRY = 'Para ir ao Drive, a mídia vira uma nota de mídia na biblioteca.'

/** The words of each destination. */
const WORDS = {
  drive: { action: ACTION, saving: SAVING, risk: RISK, saved: SAVED, failed: 'Não deu para salvar no Drive.' },
  app: {
    action: 'Salvar no App',
    saving: 'Salvando no App…',
    risk: 'Hoje este arquivo está só neste navegador: se os dados do navegador forem limpos, ele se perde. No App, ele fica na sua conta, disponível em qualquer aparelho.',
    saved: 'Salvo no App. Agora ele está disponível em qualquer aparelho.',
    failed: 'Não deu para salvar no App.',
  },
}

/** What is uploading now, because the same file can be on screen twice: in a list and in its note. */
const useSaving = create<{ ids: ReadonlySet<string> }>(() => ({ ids: new Set() }))

const failureOf = (failure: unknown, fallback: string) => (failure instanceof Error ? failure.message : fallback)

/** Asks of any file whether it is kept only in this browser. A Drive address wins over a copy in Mídias. */
export function useOnlyHere(): (file: FileMeta) => boolean {
  const library = useLibraryStore(state => (state.repo?.kind === 'drive' ? 'drive' : 'navegador'))
  const media = useLibraryStore(state => state.localMedia)
  const localMedia = useMemo(() => new Set(media.flatMap(item => item.fileIds)), [media])
  return file => placeOf(file, { localMedia, library, now: Date.now() }) === 'navegador'
}

function AskToSave({ words, size, extra, onCancel, onSave }: { words: (typeof WORDS)['drive']; size: string; extra?: string; onCancel(): void; onSave(): void }) {
  // Esc closes this window only, not Mídias under it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  const stop = (event: React.SyntheticEvent) => event.stopPropagation()
  return createPortal(
    // React events cross the portal: unstopped, a click here would also open the row behind it.
    <div onClick={stop} onKeyDown={stop} onContextMenu={stop}>
      <Dialog
        title={`${words.action}?`}
        size="narrow"
        onClose={onCancel}
        footer={
          <>
            <button className="btn quiet" onClick={onCancel}>
              Agora não
            </button>
            <button className="btn primary" onClick={onSave}>
              {words.action}
            </button>
          </>
        }
      >
        <div className="db">
          <span className="muted">
            {words.risk}
            {size && ` Tamanho: ${size}.`}
          </span>
          {extra && <span className="muted">{extra}</span>}
        </div>
      </Dialog>
    </div>,
    document.body,
  )
}

interface SaveToDriveProps {
  /** The item that keeps the media. */
  fileId?: string
  /** A media in Mídias with no item yet (T136): saving gives it an entrada, without a note, and sends it to the Drive. */
  media?: LocalMedia
  /** The one line of the lists. Only with a Google account: in the Local profile every row would say the same. */
  compact?: boolean
  /** Only the action: where the media is, the screen already says. */
  bare?: boolean
}

export function SaveToDrive({ fileId, media, compact = false, bare = false }: SaveToDriveProps) {
  // what is uploading is told by this key; an entrada made on the way (T136) takes the key too, as the list below moves to it
  const key = fileId ?? media?.storedName ?? ''
  const file = useLibraryStore(state => (fileId ? state.files.find(item => item.id === fileId) : undefined))
  const local = useLibraryStore(state => (fileId ? state.localMedia.find(item => item.fileIds.includes(fileId)) : undefined))
  const repoKind = useLibraryStore(state => state.repo?.kind)
  const shared = useLibraryStore(state => Boolean(state.sharedView))
  const appOn = useLibraryStore(state => state.appOn)
  const saving = useSaving(state => state.ids.has(key))
  const onlyHere = useOnlyHere()
  const openOverlay = useUiStore(state => state.open)
  const toast = useUiStore(state => state.toast)
  const [asking, setAsking] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  // The Google window has to open inside the tap: the script is brought in before it.
  useEffect(() => {
    if (repoKind && repoKind !== 'drive') preloadGoogleAccounts()
  }, [repoKind])

  if ((!file && !media) || !repoKind || shared || (compact && repoKind !== 'drive') || (file && !onlyHere(file))) return null

  // An entrada kept in the Mídias of another browser: there is nothing here to upload.
  const canSave = Boolean(media) || isNote(file!) || Boolean(local || file!.origin?.storedFileId)
  // a note goes to the App when the structure is on; a media with no note yet keeps the Drive road (T136)
  const words = appOn && fileId ? WORDS.app : WORDS.drive
  const busy = saving || signingIn
  const busyText = saving ? words.saving : 'Entrando…'

  const signIn = async () => {
    setSigningIn(true)
    try {
      await useAccountStore.getState().addGoogleAccount({ sendLocal: true })
      // Same road as the account menu: what is in the Local profile does not follow the sign-in by itself.
      openOverlay({ kind: 'send-local' })
    } catch (failure) {
      toast(failureOf(failure, 'O login falhou.'))
    } finally {
      setSigningIn(false)
    }
  }

  const save = async () => {
    setAsking(false)
    const marked = [key]
    const mark = (id: string) => useSaving.setState(state => ({ ids: new Set(state.ids).add(id) }))
    mark(key)
    try {
      if (words === WORDS.app && sideOfItem(fileId!) === 'local') {
        // a note of this browser moves to the App with its media, in the window of the move
        await usePlacesStore.getState().choosePlace([fileId!], 'app')
        if (sideOfItem(fileId!) !== 'app') return
      } else {
        // the upload holds the app in its window, with how much went and Cancelar (between parts; what went stays for a next try)
        await blocking(
          words.saving,
          async blocker => {
            watchedUpload.cancelled = () => blocker.cancelled
            watchedUpload.onProgress = progress => blocker.progress({ phase: 'Enviando a mídia', doneBytes: progress.sentBytes, totalBytes: progress.totalBytes })
            try {
              if (media) {
                await saveLocalMediaToDrive(media, entryId => {
                  marked.push(entryId)
                  mark(entryId)
                })
              } else await saveToDrive(fileId!)
            } finally {
              watchedUpload.cancelled = undefined
              watchedUpload.onProgress = undefined
            }
          },
          { cancellable: true },
        )
      }
      toast(words.saved)
    } catch (failure) {
      if (failure instanceof UploadCancelled) return toast(failure.message)
      toast(failureOf(failure, words.failed))
    } finally {
      useSaving.setState(state => ({ ids: new Set([...state.ids].filter(id => !marked.includes(id))) }))
    }
  }

  // Rows open on click and on Enter: the control keeps both to itself.
  const control = {
    disabled: busy,
    onClick: (event: React.MouseEvent) => {
      event.stopPropagation()
      if (repoKind === 'drive') setAsking(true)
      else void signIn()
    },
    onKeyDown: (event: React.KeyboardEvent) => event.stopPropagation(),
  }
  const bytes = media?.size || local?.size || file?.origin?.sizeBytes
  const ask = asking && <AskToSave words={words} size={bytes ? formatBytes(bytes) : ''} extra={media ? NEW_ENTRY : undefined} onCancel={() => setAsking(false)} onSave={() => void save()} />

  if (compact) {
    if (!canSave) return <span className="sdrive-row">{NOTICE}</span>
    const line = `${NOTICE} · ${busy ? busyText : words.action}`
    return (
      <>
        <button className="sdrive-row" aria-label={busy ? line : `${line}: ${file!.name}`} {...control}>
          {line}
        </button>
        {ask}
      </>
    )
  }

  return (
    <span className="sdrive">
      {!bare && <span>{NOTICE}</span>}
      {canSave && (
        <button className="btn sdrive-btn" {...control}>
          <Icon name="upload" />
          {busy ? busyText : words.action}
        </button>
      )}
      {ask}
    </span>
  )
}
