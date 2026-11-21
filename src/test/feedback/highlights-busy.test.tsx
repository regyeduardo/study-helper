import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

import { NotesPanel } from '@/components/reader/Inspector'
import { useLibraryStore } from '@/stores/library'
import { settle, slowLibrary, toastsNow } from '@/test/feedback/slow'
import type { Highlight } from '@/types/domain'

// Destacar and "Salvar nota" write to the Drive: what the person did is on screen before the write ends.

let slow: ReturnType<typeof slowLibrary>
let id: string

const store = () => useLibraryStore.getState()
const highlightsNow = () => store().opened[id]?.sidecar.highlights ?? []
const mark = (text = ''): Highlight => ({ id: `h-${Math.random()}`, kind: 'highlight', quote: 'laterais', text, color: 'yellow', startOffset: null, endOffset: null, createdAt: '2026-11-12T10:00:00Z', updatedAt: '2026-11-12T10:00:00Z' })

beforeEach(async () => {
  slow = slowLibrary()
  id = (await store().createFile({ name: 'Limites', type: 'class', status: 'ready', folderId: null }, '# Limites\n\nSe os laterais diferem.')).id
})

describe('destaques e notas aparecem na hora', () => {
  it('saveHighlight: o destaque já está no texto antes de o Drive gravar; no fim, gravado', async () => {
    const release = slow.hold()
    const item = mark()
    const saving = store().saveHighlight(id, item)
    expect(highlightsNow().map(entry => entry.id)).toEqual([item.id])
    release()
    await saving
    expect(slow.sidecars.get(id)?.highlights.map(entry => entry.id)).toEqual([item.id])
  })

  it('saveHighlight falha: o destaque some de novo e o erro chega a quem chamou', async () => {
    slow.breakWith(new Error('Drive fora do ar'))
    await expect(store().saveHighlight(id, mark())).rejects.toThrow('Drive fora do ar')
    expect(highlightsNow()).toHaveLength(0)
  })

  it('removeHighlight: o destaque sai na hora; se o Drive falha, volta', async () => {
    const item = mark()
    await store().saveHighlight(id, item)
    const release = slow.hold()
    const removing = store().removeHighlight(id, item.id)
    expect(highlightsNow()).toHaveLength(0)
    release()
    await removing
    await store().saveHighlight(id, item)
    slow.breakWith(new Error('Drive fora do ar'))
    await expect(store().removeHighlight(id, item.id)).rejects.toThrow('Drive fora do ar')
    expect(highlightsNow().map(entry => entry.id)).toEqual([item.id])
  })

  it('dois destaques seguidos, com o Drive devagar, ficam os dois', async () => {
    const release = slow.hold()
    const first = mark()
    const second = mark()
    const saving = Promise.all([store().saveHighlight(id, first), store().saveHighlight(id, second)])
    expect(highlightsNow().map(entry => entry.id)).toEqual([first.id, second.id])
    release()
    await saving
    expect(highlightsNow()).toHaveLength(2)
  })
})

describe('Notas (painel): "Salvar nota"', () => {
  const open = () => render(<NotesPanel fileId={id} />)

  it('a caixa fecha e a nota aparece na lista antes de o Drive responder', async () => {
    await store().openFile(id)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Nova nota' }))
    fireEvent.change(screen.getByLabelText('Texto da nota'), { target: { value: 'Rever os laterais' } })
    slow.hold()
    fireEvent.click(screen.getByRole('button', { name: 'Salvar nota' }))
    expect(screen.queryByLabelText('Texto da nota')).not.toBeInTheDocument()
    expect(screen.getByText('Rever os laterais')).toBeInTheDocument()
  })

  it('o Drive falha: a caixa volta com o texto e um aviso diz o motivo', async () => {
    await store().openFile(id)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Nova nota' }))
    fireEvent.change(screen.getByLabelText('Texto da nota'), { target: { value: 'Rever os laterais' } })
    slow.breakWith(new Error('Drive fora do ar'))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar nota' }))
    await act(async () => {
      await settle()
    })
    expect(screen.getByLabelText('Texto da nota')).toHaveValue('Rever os laterais')
    expect(toastsNow().join(' ')).toMatch(/Drive fora do ar/)
    expect(highlightsNow()).toHaveLength(0)
  })
})
