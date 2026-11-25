// Spec 007, história 2 (T092, achado das três revisões): a linha de um trabalho da conta diz o que foi pedido. O título vem da conta
// como "Etiquetas · Nota" (`routeOf` em src/lib/generation/account-routing.ts); antes, só "Ata: Nota" era lido, e a coluna "O que" caía
// no tipo da nota: sugerir etiquetas de uma explicação aparecia como "Explicação", e a transcrição de uma reunião como "Ata".
import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { GenerationList } from '@/components/library/GenerationList'
import { type Generation, useGenerationsStore } from '@/stores/generations'
import { useLibraryStore } from '@/stores/library'
import type { FileMeta } from '@/types/domain'

const note = (id: string, name: string, type: FileMeta['type']) => ({ id, name, type, folderId: null, deletedAt: null, tags: [] }) as unknown as FileMeta

const line = (id: string, title: string, fileId: string): Generation =>
  ({ id: `conta:${id}`, accountJob: id, kind: 'generation', title, state: 'running', fileId, message: '', fraction: null, startedAt: Date.now() }) as unknown as Generation

afterEach(() => {
  useGenerationsStore.setState({ items: [] })
  useLibraryStore.setState({ files: [] })
})

describe('o que um trabalho da conta está fazendo', () => {
  it('a coluna "O que" vem do título da conta, não do tipo da nota', () => {
    useLibraryStore.setState({ files: [note('n1', 'Nota de estudo 0002', 'explanation'), note('n2', 'Reunião de segunda', 'meeting'), note('n3', 'Aula de cálculo', 'class')] })
    useGenerationsStore.setState({
      items: [line('a', 'Etiquetas · Nota de estudo 0002', 'n1'), line('b', 'Transcrição · Reunião de segunda', 'n2'), line('c', 'Gerando · Aula de cálculo', 'n3')],
    })
    render(
      <MemoryRouter>
        <GenerationList />
      </MemoryRouter>,
    )
    const table = screen.getByRole('table', { name: 'Gerando' })
    const what = (name: string) => within(table).getByRole('row', { name }).querySelector('.gen-what')?.textContent
    expect(what('Nota de estudo 0002')).toBe('Etiquetas')
    expect(what('Reunião de segunda')).toBe('Transcrição')
    // "Gerando" não diz o quê: vale o tipo da nota, como antes
    expect(what('Aula de cálculo')).toBe('Aula')
  })

  it('sem a nota à mão, o nome vem do título, sem o que foi pedido na frente', () => {
    useGenerationsStore.setState({ items: [line('d', 'Etiquetas · Nota apagada', 'sumiu'), line('e', 'Etiquetas · Explicação: Nota de estudo 0001', 'sumiu-tambem')] })
    render(
      <MemoryRouter>
        <GenerationList />
      </MemoryRouter>,
    )
    const table = screen.getByRole('table', { name: 'Gerando' })
    expect(within(table).getByRole('row', { name: 'Nota apagada' }).querySelector('.gen-what')?.textContent).toBe('Etiquetas')
    // o nome da nota pode ter ": ": vale o primeiro separador
    expect(within(table).getByRole('row', { name: 'Explicação: Nota de estudo 0001' }).querySelector('.gen-what')?.textContent).toBe('Etiquetas')
  })
})
