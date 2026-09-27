import { useState } from 'react'

import { Icon } from '@/components/ui/Icon'
import { TypeDot } from '@/components/library/Badges'
import { TRASH_DAYS, useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

function daysLeft(deletedAt: string): number {
  return Math.max(0, TRASH_DAYS - Math.floor((Date.now() - Date.parse(deletedAt)) / (24 * 3600 * 1000)))
}

export function TrashList({ compact = false }: { compact?: boolean }) {
  const library = useLibraryStore()
  const ui = useUiStore()
  const [confirming, setConfirming] = useState<string | null>(null)
  const files = library.files.filter(file => file.deletedAt)
  const folders = library.folders.filter(folder => folder.deletedAt)
  const items = [
    ...folders.map(folder => ({ kind: 'folder' as const, id: folder.id, name: folder.name, deletedAt: folder.deletedAt!, type: null })),
    ...files.map(file => ({ kind: 'file' as const, id: file.id, name: file.name, deletedAt: file.deletedAt!, type: file.type })),
  ].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))

  if (!items.length) {
    return (
      <div className="empty">
        <Icon name="trash" />
        <div>A lixeira está vazia.</div>
      </div>
    )
  }

  return (
    <div className="list" style={{ maxWidth: 920, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 14px 8px', gap: 8, flexWrap: 'wrap' }}>
        <span className="faint" style={{ fontSize: 12.5 }}>
          O que passa de {TRASH_DAYS} dias aqui é apagado de vez.
        </span>
        <button
          className="btn quiet danger"
          onClick={() =>
            ui.open({
              kind: 'confirm',
              title: 'Esvaziar a lixeira?',
              text: `Apaga de vez ${items.length} item(ns). Não dá para desfazer.`,
              ok: 'Esvaziar',
              danger: true,
              onConfirm: async () => {
                await library.emptyTrash()
                ui.toast('Lixeira vazia')
              },
            })
          }
        >
          Esvaziar a lixeira
        </button>
      </div>
      {items.map(item => {
        const children = item.kind === 'file' ? library.files.filter(file => file.parentFileId === item.id && !file.deletedAt).length : 0
        return (
          <div key={item.id} className={compact ? 'card' : 'row'} style={{ cursor: 'default' }}>
            <span>
              <Icon name={item.kind === 'folder' ? 'folder' : 'file'} />
            </span>
            <div>
              <div className="title">{item.name}</div>
              <div className="sub">
                {item.type && <TypeDot type={item.type} />}
                <span>
                  apagado em {new Date(item.deletedAt).toLocaleDateString('pt-BR')} · some em {daysLeft(item.deletedAt)} dias
                </span>
              </div>
              {confirming === item.id && (
                <div className="inline-confirm" style={{ marginTop: 8 }}>
                  Apagar de vez? Não dá para desfazer.{children ? ` ${children} explicação(ões) apontam para este arquivo e perdem a origem.` : ''}
                  <button
                    className="btn danger"
                    onClick={async () => {
                      setConfirming(null)
                      if (item.kind === 'folder') await library.deleteFolderForever(item.id)
                      else await library.deleteFileForever(item.id)
                      ui.toast('Apagado de vez')
                    }}
                  >
                    Apagar de vez
                  </button>
                  <button className="btn quiet" onClick={() => setConfirming(null)}>
                    Cancelar
                  </button>
                </div>
              )}
            </div>
            <div className="side" style={compact ? { display: 'grid', gap: 4 } : undefined}>
              <button
                className="btn"
                onClick={async () => {
                  if (item.kind === 'folder') await library.restoreFolder(item.id)
                  else await library.restoreFile(item.id)
                  ui.toast('Restaurado')
                }}
              >
                <Icon name="undo" />
                Restaurar
              </button>
              <button className="btn quiet danger" onClick={() => setConfirming(item.id)}>
                Apagar de vez
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
