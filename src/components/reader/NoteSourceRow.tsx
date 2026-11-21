// "Detalhes" of a note made of a link, a text or a topic: where it came from, and "Virar entrada" (then "Ver a entrada").
import { useNavigate } from 'react-router-dom'

import type { FileMeta, NoteSource } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { useBusy } from '@/hooks/use-busy'
import { entryOfSource, shortText } from '@/lib/note-source'
import { paths } from '@/lib/paths'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

const LABEL: Record<NoteSource['kind'], string> = { link: 'De onde veio', text: 'Pedido', topic: 'Tema' }

/** The link as the person reads it: its page's title, else the address without "https://www.". */
const linkName = (source: NoteSource) => source.title || (source.url ?? '').replace(/^https?:\/\/(www\.)?/i, '')

export function NoteSourceRow({ meta }: { meta: FileMeta & { source: NoteSource } }) {
  const navigate = useNavigate()
  const shared = useLibraryStore(state => Boolean(state.sharedView))
  const entry = useLibraryStore(state => entryOfSource(state.files, meta))
  const turnIntoEntry = useJobsStore(state => state.turnIntoEntry)
  const toast = useUiStore(state => state.toast)
  const [busy, run] = useBusy()
  const { source } = meta
  const turn = async () => {
    const id = await run(() =>
      turnIntoEntry(meta.id).catch(error => {
        toast(`Não deu para guardar a fonte como nota: ${error instanceof Error ? error.message : 'tente de novo.'}`)
        return null
      }),
    )
    if (id) toast('A fonte virou nota. Esta nota agora é filha dela.')
  }
  return (
    <div>
      <dt>{LABEL[source.kind]}</dt>
      <dd className="doc-source">
        {source.kind === 'link' && source.url && /^https?:\/\//i.test(source.url) ? (
          <a href={source.url} target="_blank" rel="noreferrer" title={source.url}>
            <Icon name="link" />
            {linkName(source)}
          </a>
        ) : (
          <span className="doc-source-text" title={source.text ?? source.url}>
            {shortText(source.text ?? source.url ?? '')}
          </span>
        )}
        {!shared &&
          (entry ? (
            <button className="doc-source-act" onClick={() => navigate(paths.entry(entry.id))}>
              Ver a nota da fonte
            </button>
          ) : (
            <button className="doc-source-act" disabled={busy} onClick={() => void turn()} title="Guarda a fonte como uma nota do seu tipo (Link, Texto ou Tema), e esta nota passa a ser filha dela">
              {busy && <Icon name="sync" className="spinning" />}
              {busy ? 'Guardando…' : 'Guardar como nota'}
            </button>
          ))}
      </dd>
    </div>
  )
}
