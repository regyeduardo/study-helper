// "Gerar a partir disto": a link or a passage selected in a note becomes a note of its own, the note's child, keeping what was selected as its source.
import { useState } from 'react'

import type { NoteAgent } from '@/stores/jobs'
import { FolderField } from '@/components/dialogs/FolderChooser'
import { MoreOptions } from '@/components/dialogs/FromNoteFields'
import { useGoToNew } from '@/components/dialogs/go-to-new'
import { MediaAnalysisField, useMediaAnalysis } from '@/components/dialogs/MediaAnalysisField'
import { type ModelChoice, ModelPick, useModelChoice } from '@/components/dialogs/ModelPick'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { youtubeId } from '@/controllers/sources.controller'
import { selectionTitle } from '@/lib/generation/course-lesson'
import { linkIn } from '@/lib/note-source'
import { paths } from '@/lib/paths'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { asking } from '@/stores/retry'
import { type GenerationPrefill, type Overlay, useUiStore } from '@/stores/ui'

const WRITES: { id: NoteAgent; label: string; hint: string }[] = [
  { id: 'lesson', label: 'Aula', hint: 'Para aprender o conteúdo' },
  { id: 'explanation', label: 'Explicação', hint: 'Direto ao ponto' },
  { id: 'meeting', label: 'Ata', hint: 'Pontos relevantes e tarefas' },
]

const PLACEHOLDER: Record<NoteAgent, string> = { lesson: 'Ex.: foque na parte prática', explanation: 'Ex.: com um exemplo do dia a dia', meeting: 'Ex.: foque nas decisões e nas tarefas' }

/** `prefill`: the window as it was when that generation failed. */
export function FromSelectionDialog({ fileId, excerpt, prefill }: { fileId: string; excerpt: string; prefill?: GenerationPrefill }) {
  const close = useUiStore(state => state.close)
  const goToNew = useGoToNew()
  const note = useLibraryStore(state => state.files.find(file => file.id === fileId))
  const generateFromSelection = useJobsStore(state => state.generateFromSelection)
  const url = linkIn(excerpt)
  const youtube = Boolean(url && youtubeId(url))
  // after a failure, the model of what was asked comes back as it was
  const asked = (goal: NoteAgent) => (prefill?.goal === goal ? { ...(prefill.model ? { pick: prefill.model } : {}), ...(prefill.videoWrites ? { videoWrites: true } : {}) } : undefined)
  const choices: Record<NoteAgent, ModelChoice> = {
    lesson: useModelChoice('aula', false, asked('lesson')),
    explanation: useModelChoice('explicacao', false, asked('explanation')),
    meeting: useModelChoice('ata', false, asked('meeting')),
  }
  const [goal, setGoal] = useState<NoteAgent>(prefill?.goal && prefill.goal !== 'transcribe' ? prefill.goal : 'lesson')
  const choice = choices[goal]
  // a YouTube link: the model watches the video, reads its legenda, or both, as from any YouTube entrada
  const analysis = useMediaAnalysis(choice, youtube, null, { youtube, initial: prefill?.analyze })
  const [folderId, setFolderId] = useState<string | null | undefined>(prefill && 'folderId' in prefill ? prefill.folderId : undefined)
  const [choosing, setChoosing] = useState(false)
  const [instruction, setInstruction] = useState(prefill?.instruction ?? '')
  const [inSight] = useState(Boolean(instruction))
  if (!note) return null
  const destination = folderId === undefined ? note.folderId : folderId
  const label = WRITES.find(item => item.id === goal)!.label

  const start = () => {
    close()
    // a failure brings this window back as it is now
    const retry: Overlay = {
      kind: 'from-selection',
      fileId,
      excerpt,
      prefill: { goal, ...(choice.touched && choice.pick ? { model: choice.pick } : {}), ...(choice.videoWrites ? { videoWrites: true } : {}), instruction, ...(folderId !== undefined ? { folderId } : {}), ...(analysis.sent ? { analyze: analysis.sent } : {}) },
    }
    void asking([fileId], retry, () => generateFromSelection(fileId, excerpt, goal, choice.model || null, { folderId: destination }, instruction, youtube ? analysis.sent : undefined)).then(id => id && goToNew(paths.file(id), `Gerando a ${label}`))
  }

  return (
    <Dialog
      title="Gerar a partir disto"
      size="narrow"
      onClose={choosing ? undefined : close}
      footer={
        <>
          <button className="btn quiet" onClick={close}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!choice.ready} onClick={start}>
            Gerar
          </button>
        </>
      }
    >
      <div className="db">
        <p className="muted" style={{ marginTop: 0 }}>
          {`A nota nova nasce de “${note.name}” e guarda ${url ? 'o link' : 'o trecho'} de onde veio.`}
        </p>
        {url ? (
          <div className="note">
            <a href={url} target="_blank" rel="noreferrer">
              {url}
            </a>
          </div>
        ) : (
          <div className="note">
            <q>{excerpt}</q>
          </div>
        )}
        {youtube && (
          <div className="banner info">
            <Icon name="info" />
            <span>Vídeo do YouTube: vira uma nota de vídeo dentro desta, e a nota nova é filha dela.</span>
          </div>
        )}
        <div className="field">
          <span className="lab">O que gerar</span>
          <div className="opts cols2" role="radiogroup" aria-label="O que gerar">
            {WRITES.map(item => (
              <button key={item.id} className="opt" role="radio" aria-checked={goal === item.id} onClick={() => setGoal(item.id)}>
                <span className="radio" />
                <span>
                  <b>{item.label}</b>
                  <span>{item.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <ModelPick choice={choice} />
        {youtube && <MediaAnalysisField analysis={analysis} />}
        <div className="field">
          <span className="lab">Salvar em</span>
          <FolderField value={destination} onChange={setFolderId} label="Salvar em" title="Onde salvar a nota nova" leaf={`${label}: ${url ?? selectionTitle(excerpt)}`} open={choosing} onOpenChange={setChoosing} />
        </div>
        <MoreOptions instruction={instruction} onInstruction={setInstruction} placeholder={PLACEHOLDER[goal]} open={inSight} />
      </div>
    </Dialog>
  )
}
