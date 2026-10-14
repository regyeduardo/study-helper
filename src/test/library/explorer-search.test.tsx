import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { searchFile } from '@/lib/library-search'
import { FILES, renderAt, seedLibrary } from '@/test/library/explorer-fixture'

beforeEach(() => {
  seedLibrary()
})

const rows = () => within(screen.getByRole('table', { name: 'Notas e pastas' })).getAllByRole('row').slice(1)
const lit = () => rows().filter(row => row.classList.contains('hit')).map(row => row.textContent)

describe('search lights up the explorer itself', () => {
  it('finds the words ignoring accents and case, in the text and in what was said, with the minute', () => {
    const recording = { blocks: [{ speaker: 'mic', start: 40, end: 52, text: 'Aí o LIMITE da função não existe.' }], speakers: [], marks: [] }
    const hit = searchFile(FILES[1], { content: '', sidecar: { recording } as never }, 'limite nao existe')
    expect(hit?.at).toBe(40)
    expect(hit?.parts.filter(part => part.hit).map(part => part.text)).toEqual(['LIMITE', 'não', 'existe'])
    expect(hit?.parts.map(part => part.text).join('')).toBe('Aí o LIMITE da função não existe.')
    expect(searchFile(FILES[3], { content: 'A derivada é um limite.', sidecar: {} as never }, 'limite nao existe')).toBeNull()
  })

  it('the rows that match light up with the excerpt, the others stay, and a folder shows how many are inside', async () => {
    renderAt('/biblioteca/calc')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), { target: { value: 'limite não existe' } })
    await waitFor(() => expect(lit()).toHaveLength(3))
    expect(rows()).toHaveLength(6)
    const [integrais, limites, monitoria] = lit()
    expect(integrais).toContain('1 resultado dentro')
    expect(limites).toContain('Se os laterais diferem, o limite não existe.')
    expect(monitoria).toContain('00:40')
    expect(monitoria).toContain('Pode, e aí o limite da função não existe.')
    expect(within(rows()[4]).getAllByText(/./, { selector: 'mark' }).map(mark => mark.textContent)).toEqual(['limite', 'não', 'existe'])
    expect(within(screen.getByRole('tree', { name: 'Pastas' })).getByRole('treeitem', { name: 'Integrais' })).toHaveTextContent('(1)')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), { target: { value: '' } })
    expect(lit()).toHaveLength(0)
  })
})
