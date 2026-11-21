// "Salvar no meu Drive" (FR-043): what is kept only in this browser says so, wherever it appears, and offers the Drive.
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'

import type { FileMeta } from '@/types/domain'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { preloadGoogleAccounts } from '@/controllers/google-auth.controller'
import { isNote } from '@/lib/family'
import { placeOf } from '@/lib/library-filters'
import type { LocalMedia } from '@/lib/recording/media-library'
import { saveLocalMediaToDrive, saveToDrive } from '@/lib/storage/source-storage'
import { useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import '@/styles/save-to-drive.css'
import { formatBytes } from '@/utils/format'

const NOTICE = 'Só neste navegador'
const ACTION = 'Salvar no meu Drive'
const SAVING = 'Salvando no Drive…'
const RISK = 'Hoje este arquivo está só neste navegador: se os dados do navegador forem limpos, ele se perde. No Drive, ele fica na sua conta, disponível em qualquer aparelho.'
const SAVED = 'Salvo no seu Drive. Agora ele está disponível em qualquer aparelho.'
const NEW_ENTRY = 'Para ir ao Drive, a mídia vira uma nota de mídia na biblioteca.'

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

function AskToSave({ size, extra, onCancel, onSave }: { size: string; extra?: string; onCancel(): void; onSave(): void }) {
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
        title={`${ACTION}?`}
        size="narrow"
        onClose={onCancel}
        footer={
          <>
            <button className="btn quiet" onClick={onCancel}>
              Agora não
            </button>
            <button className="btn primary" onClick={onSave}>
              {ACTION}
            </button>
          </>
        }
      >
        <div className="db">
          <span className="muted">
            {RISK}
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
  const busy = saving || signingIn
  const busyText = saving ? SAVING : 'Entrando…'

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
      if (media) {
        await saveLocalMediaToDrive(media, entryId => {
          marked.push(entryId)
          mark(entryId)
        })
      } else await saveToDrive(fileId!)
      toast(SAVED)
    } catch (failure) {
      toast(failureOf(failure, 'Não deu para salvar no Drive.'))
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
  const ask = asking && <AskToSave size={bytes ? formatBytes(bytes) : ''} extra={media ? NEW_ENTRY : undefined} onCancel={() => setAsking(false)} onSave={() => void save()} />

  if (compact) {
    if (!canSave) return <span className="sdrive-row">{NOTICE}</span>
    const line = `${NOTICE} · ${busy ? busyText : ACTION}`
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
          {busy ? busyText : ACTION}
        </button>
      )}
      {ask}
    </span>
  )
}
