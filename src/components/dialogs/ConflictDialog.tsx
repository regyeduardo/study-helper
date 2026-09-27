import { useMemo, useState } from 'react'

import { Dialog } from '@/components/ui/Dialog'
import type { Conflict, JsonConflict, TextConflict } from '@/lib/storage/repository'
import { mergeText, type TextHunk } from '@/lib/sync/merge'
import { useLibraryStore } from '@/stores/library'
import { useSyncStore } from '@/stores/sync'

type Pick = 'mine' | 'theirs' | 'both'

const CONTEXT_LINES = 2

function stampText(stamp: { at: string; deviceName: string }, timeZone: string): string {
  return `${stamp.deviceName} · ${new Date(stamp.at).toLocaleString('pt-BR', { timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
}

function TextConflictView({ conflict, onDone, onLater }: { conflict: TextConflict; onDone(resolved: Conflict): void; onLater(): void }) {
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  const hunks = useMemo(() => mergeText(conflict.base, conflict.mine, conflict.theirs), [conflict])
  const conflicts = hunks.map((hunk, index) => ({ hunk, index })).filter(item => item.hunk.kind === 'conflict')
  const [picks, setPicks] = useState<Record<number, Pick>>({})

  const apply = () => {
    const lines = hunks.flatMap((hunk: TextHunk, index) => {
      if (hunk.kind === 'same') return hunk.resolved
      const pick = picks[index] ?? 'mine'
      return pick === 'mine' ? hunk.mine : pick === 'theirs' ? hunk.theirs : [...hunk.mine, ...hunk.theirs]
    })
    onDone({ ...conflict, resolved: lines.join('\n') })
  }

  return (
    <Dialog
      title={`Conflito em “${conflict.fileName}”`}
      size="wide"
      onClose={onLater}
      footer={
        <>
          <span className="grow">
            {Object.keys(picks).length} de {conflicts.length} trechos escolhidos
          </span>
          <button className="btn quiet" onClick={onLater}>
            Decidir depois
          </button>
          <button className="btn primary" disabled={Object.keys(picks).length < conflicts.length} onClick={apply}>
            Juntar e salvar
          </button>
        </>
      }
    >
      <div className="db">
        <span className="muted" style={{ fontSize: 13 }}>
          Os dois lados mudaram a nota antes de sincronizar. Só as diferenças aparecem; escolha trecho por trecho.
        </span>
        <div className="diff">
          {hunks.map((hunk, index) => {
            if (hunk.kind === 'same') {
              const near = conflicts.some(item => Math.abs(item.index - index) === 1)
              if (!near) return null
              const lines = conflicts.some(item => item.index === index + 1) ? hunk.resolved.slice(-CONTEXT_LINES) : hunk.resolved.slice(0, CONTEXT_LINES)
              return lines.map((line, position) => (
                <div key={`${index}-${position}`} className="dline same">
                  {line || ' '}
                </div>
              ))
            }
            return (
              <div key={index} className="chunk">
                <div className="side">
                  <div className="mine">
                    <div className="who">
                      <b>Este navegador</b>
                      <span>{stampText(conflict.mineStamp, timeZone)}</span>
                    </div>
                    {hunk.mine.map((line, position) => (
                      <div key={position} className="dline">
                        {line || ' '}
                      </div>
                    ))}
                    {!hunk.mine.length && <div className="dline faint">(apagado)</div>}
                  </div>
                  <div className="theirs">
                    <div className="who">
                      <b>Outro lado</b>
                      <span>{stampText(conflict.theirsStamp, timeZone)}</span>
                    </div>
                    {hunk.theirs.map((line, position) => (
                      <div key={position} className="dline">
                        {line || ' '}
                      </div>
                    ))}
                    {!hunk.theirs.length && <div className="dline faint">(apagado)</div>}
                  </div>
                </div>
                <div className="pick">
                  {(
                    [
                      ['mine', 'Ficar com a minha'],
                      ['theirs', 'Ficar com a outra'],
                      ['both', 'Manter as duas'],
                    ] as [Pick, string][]
                  ).map(([key, label]) => (
                    <button key={key} className="chip" aria-pressed={picks[index] === key} onClick={() => setPicks(state => ({ ...state, [index]: key }))}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </Dialog>
  )
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'sim' : 'não'
  if (Array.isArray(value)) return value.join(', ') || '—'
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 160)
  return String(value)
}

function JsonConflictView({ conflict, onDone, onLater }: { conflict: JsonConflict; onDone(resolved: Conflict): void; onLater(): void }) {
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  const [choices, setChoices] = useState<Record<string, 'mine' | 'theirs'>>({})
  return (
    <Dialog
      title={`Conflito nas informações de “${conflict.fileName}”`}
      size="wide"
      onClose={onLater}
      footer={
        <>
          <button className="btn quiet" onClick={onLater}>
            Decidir depois
          </button>
          <button className="btn primary" disabled={Object.keys(choices).length < conflict.fields.length} onClick={() => onDone({ ...conflict, fields: conflict.fields.map(field => ({ ...field, choice: choices[field.path] })) })}>
            Salvar
          </button>
        </>
      }
    >
      <div className="db">
        <span className="muted" style={{ fontSize: 13 }}>
          O que só somou (provas feitas, notas novas) já foi juntado sozinho. Estes itens mudaram dos dois lados:
        </span>
        <div className="diff">
          {conflict.fields.map(field => (
            <div key={field.path} className="chunk">
              <div className="dline same">{field.label}</div>
              <div className="side">
                <div className="mine">
                  <div className="who">
                    <b>Este navegador</b>
                    <span>{stampText(conflict.mineStamp, timeZone)}</span>
                  </div>
                  <div className="dline">{display(field.mine)}</div>
                </div>
                <div className="theirs">
                  <div className="who">
                    <b>Outro lado</b>
                    <span>{stampText(conflict.theirsStamp, timeZone)}</span>
                  </div>
                  <div className="dline">{display(field.theirs)}</div>
                </div>
              </div>
              <div className="pick">
                <button className="chip" aria-pressed={choices[field.path] === 'mine'} onClick={() => setChoices(state => ({ ...state, [field.path]: 'mine' }))}>
                  Ficar com a minha
                </button>
                <button className="chip" aria-pressed={choices[field.path] === 'theirs'} onClick={() => setChoices(state => ({ ...state, [field.path]: 'theirs' }))}>
                  Ficar com a outra
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  )
}

export function ConflictDialog() {
  const { conflicts, conflictsHidden, settleConflict, hideConflicts } = useSyncStore()
  const pending = conflicts[0]
  if (!pending || conflictsHidden) return null
  const done = (resolved: Conflict) => settleConflict(pending.id, resolved)
  if (pending.conflict.kind === 'text') return <TextConflictView key={pending.id} conflict={pending.conflict} onDone={done} onLater={hideConflicts} />
  return <JsonConflictView key={pending.id} conflict={pending.conflict} onDone={done} onLater={hideConflicts} />
}
