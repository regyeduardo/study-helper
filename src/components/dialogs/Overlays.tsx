import { useEffect } from 'react'

import { AccountMenu } from '@/components/dialogs/AccountMenu'
import { CommandPalette } from '@/components/dialogs/CommandPalette'
import { ConflictDialog } from '@/components/dialogs/ConflictDialog'
import { ExamDialog, ExamRun, FolderExamDialog } from '@/components/dialogs/ExamDialog'
import { JobsPanel } from '@/components/dialogs/JobsPanel'
import { MediaDialog } from '@/components/dialogs/MediaDialog'
import { ModelDownloadDialog } from '@/components/dialogs/ModelDownloadDialog'
import { ActivityDialog, CourseProposalDialog, ExplainDialog, ImportDialog, OrderDialog, SendLocalDialog, StorageLimitDialog } from '@/components/dialogs/MoreDialogs'
import { NewContentDialog } from '@/components/dialogs/NewContentDialog'
import { RecordDialog, RecordingDoneDialog, RecordingWindow } from '@/components/dialogs/RecordDialogs'
import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { ShareDialog } from '@/components/dialogs/ShareDialog'
import { ConfirmDialog, MoveDialog, NewFolderDialog, RenameDialog } from '@/components/dialogs/SimpleDialogs'
import { useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

function useFirstConnection() {
  const account = useAccountStore(state => state.active())
  const ready = useLibraryStore(state => state.ready)
  const limit = useLibraryStore(state => state.index.settings.storageLimitBytes)
  const loadError = useLibraryStore(state => state.loadError)
  const open = useUiStore(state => state.open)
  const overlay = useUiStore(state => state.overlay)
  useEffect(() => {
    if (account.kind === 'google' && ready && !loadError && limit === null && !overlay) open({ kind: 'storage-limit' })
  }, [account.kind, ready, limit, loadError])
}

export function Overlays() {
  const overlay = useUiStore(state => state.overlay)
  useFirstConnection()
  let content: React.ReactNode = null
  if (overlay?.kind === 'palette') content = <CommandPalette />
  else if (overlay?.kind === 'new') content = <NewContentDialog folderId={overlay.folderId} />
  else if (overlay?.kind === 'record') content = <RecordDialog />
  else if (overlay?.kind === 'media') content = <MediaDialog />
  else if (overlay?.kind === 'settings') content = <SettingsDialog initial={overlay.tab} />
  else if (overlay?.kind === 'exam') content = <ExamDialog fileId={overlay.fileId} />
  else if (overlay?.kind === 'folder-exam') content = <FolderExamDialog folderId={overlay.folderId} fileIds={overlay.fileIds} />
  else if (overlay?.kind === 'account') content = <AccountMenu />
  else if (overlay?.kind === 'new-folder') content = <NewFolderDialog parentId={overlay.parentId} />
  else if (overlay?.kind === 'rename') content = <RenameDialog target={overlay.target} id={overlay.id} />
  else if (overlay?.kind === 'move') content = <MoveDialog fileIds={overlay.fileIds} folderIds={overlay.folderIds} />
  else if (overlay?.kind === 'confirm') content = <ConfirmDialog overlay={overlay} />
  else if (overlay?.kind === 'explain') content = <ExplainDialog fileId={overlay.fileId} excerpt={overlay.excerpt} />
  else if (overlay?.kind === 'order') content = <OrderDialog folderId={overlay.folderId} />
  else if (overlay?.kind === 'activity') content = <ActivityDialog />
  else if (overlay?.kind === 'import') content = <ImportDialog />
  else if (overlay?.kind === 'send-local') content = <SendLocalDialog />
  else if (overlay?.kind === 'storage-limit') content = <StorageLimitDialog />
  else if (overlay?.kind === 'share') content = <ShareDialog target={overlay.target} id={overlay.id} />
  else if (overlay?.kind === 'shared-exam') content = <ExamRun title={overlay.title} questions={overlay.questions} sourceOf={() => 'shared'} onRecord={(_, fields) => overlay.onRecord(fields)} />
  return (
    <>
      {content}
      <CourseProposalDialog />
      <ConflictDialog />
      <RecordingWindow />
      <RecordingDoneDialog />
      <JobsPanel />
      <ModelDownloadDialog />
    </>
  )
}
