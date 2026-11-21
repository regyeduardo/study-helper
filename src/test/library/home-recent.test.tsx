// A tela de início mostra só as últimas coisas feitas: notas e entradas criadas, geradas ou mudadas, da mais nova para a mais antiga.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import type { FileMeta, SourceMeta } from '@/types/domain'
import { useViewRoute } from '@/hooks/use-view-route'
import { newFileMeta } from '@/lib/defaults'
import { ReaderWorkspace } from '@/pages/workspace/container/reader'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { FOLDERS, seedLibrary } from '@/test/library/explorer-fixture'

// 22:50 of Nov 14 in São Paulo, already Nov 15 in UTC
const NOW = '2026-11-15T01:50:00.000Z'
const VIDEO: SourceMeta = { input: 'file', name: 'aula7.mp4', mime: 'video/mp4', durationSeconds: 4320, storage: 'none' }
const AUDIO: SourceMeta = { input: 'recording', name: 'monitoria.webm', mime: 'audio/webm', durationSeconds: 3120, storage: 'none' }
const PDF: SourceMeta = { input: 'file', name: 'stewart.pdf', mime: 'application/pdf', storage: 'none' }

function item(id: string, fields: Partial<FileMeta> & { at?: string } = {}): FileMeta {
  const { at = '2026-10-01T12:00:00.000Z', ...rest } = fields
  const stamp = { at, deviceId: 'd1', deviceName: 'Notebook' }
  return newFileMeta({ id, name: id, type: 'class', folderId: 'calc', created: stamp, updated: stamp, ...rest })
}

function put(files: FileMeta[]) {
  useLibraryStore.setState(state => ({ files, index: { ...state.index, settings: { ...state.index.settings, timezone: 'America/Sao_Paulo' } } }))
}

function Where() {
  const location = useLocation()
  return <output aria-label="rota">{`${location.pathname}${location.search}`}</output>
}

function Workspace() {
  return <ReaderWorkspace route={useViewRoute()} />
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/arquivo/:fileId" element={<Where />} />
        <Route path="/entrada/:fileId" element={<Where />} />
        <Route path="*" element={<Workspace />} />
      </Routes>
    </MemoryRouter>,
  )
}

const home = () => screen.getByRole('region', { name: 'Últimas coisas feitas' })
const rowOf = (name: string) => within(home()).getByRole('button', { name: new RegExp(`^${name}`) })
const rowNames = () => within(home()).getAllByRole('button').map(button => button.querySelector('.hr-name')?.firstChild?.textContent ?? '')
const groups = () => within(home()).queryAllByRole('heading', { level: 3 }).map(heading => heading.textContent)
const groupRows = (name: string) => within(within(home()).getByRole('heading', { level: 3, name }).closest('.hr-group') as HTMLElement).getAllByRole('button')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  seedLibrary()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Início: só o que foi feito por último', () => {
  const week = [
    item('Aula de hoje', { at: '2026-11-15T01:30:00.000Z' }),
    item('Ata do fim de tarde', { type: 'meeting', at: '2026-11-14T22:00:00.000Z' }),
    item('Ata de ontem', { type: 'meeting', at: '2026-11-14T02:30:00.000Z' }),
    item('Resumo da semana', { type: 'reading', at: '2026-11-10T15:00:00.000Z' }),
    item('Nota antiga', { type: 'reading', at: '2026-11-01T12:00:00.000Z' }),
  ]

  it('agrupa em Hoje, Ontem, Esta semana e Antes pelo fuso das configurações, da mais nova para a mais antiga', () => {
    put(week)
    renderHome()
    // 22:00 UTC of the 14th is 19:00 in São Paulo: still today; 02:30 UTC of the 14th is 23:30 of the 13th: yesterday
    expect(groups()).toEqual(['Hoje', 'Ontem', 'Esta semana', 'Antes'])
    expect(groupRows('Hoje').map(row => row.querySelector('.hr-name')?.firstChild?.textContent)).toEqual(['Aula de hoje', 'Ata do fim de tarde'])
    expect(groupRows('Ontem').map(row => row.querySelector('.hr-name')?.firstChild?.textContent)).toEqual(['Ata de ontem'])
    expect(groupRows('Esta semana')).toHaveLength(1)
    expect(groupRows('Antes')).toHaveLength(1)
  })

  it('só mostra o grupo que tem coisas', () => {
    put([week[0], week[4]])
    renderHome()
    expect(groups()).toEqual(['Hoje', 'Antes'])
  })

  it('a hora aparece hoje e a data nos outros dias', () => {
    put(week)
    renderHome()
    expect(within(rowOf('Aula de hoje')).getByText('22:30')).toBeInTheDocument()
    expect(within(rowOf('Ata do fim de tarde')).getByText('19:00')).toBeInTheDocument()
    expect(within(rowOf('Ata de ontem')).getByText('13/11')).toBeInTheDocument()
    expect(within(rowOf('Resumo da semana')).getByText('10/11')).toBeInTheDocument()
    expect(within(rowOf('Nota antiga')).getByText('01/11')).toBeInTheDocument()
  })

  it('o que mudou agora sobe: vale a data de mudança, não a de criação', () => {
    put([item('Criada cedo, mudada agora', { at: '2026-11-14T13:00:00.000Z', updated: { at: '2026-11-15T01:40:00.000Z', deviceId: 'd1', deviceName: 'Notebook' } }), item('Criada depois', { at: '2026-11-14T20:00:00.000Z' })])
    renderHome()
    expect(rowNames()).toEqual(['Criada cedo, mudada agora', 'Criada depois'])
  })

  it('cada linha diz o que é, a pasta e o horário', () => {
    put([...week, item('Ondas', { type: 'explanation', folderId: 'fis', at: '2026-11-14T20:00:00.000Z' }), item('Anotação minha', { type: 'reading', folderId: null, at: '2026-11-14T19:00:00.000Z' })])
    renderHome()
    expect(within(rowOf('Aula de hoje')).getByText('Aula')).toBeInTheDocument()
    expect(within(rowOf('Ata do fim de tarde')).getByText('Ata')).toBeInTheDocument()
    expect(within(rowOf('Ondas')).getByText('Explicação')).toBeInTheDocument()
    expect(within(rowOf('Anotação minha')).getByText('Nota')).toBeInTheDocument()
    expect(within(rowOf('Aula de hoje')).getByText('Cálculo I')).toBeInTheDocument()
    expect(within(rowOf('Ondas')).getByText('Física II')).toBeInTheDocument()
    expect(within(rowOf('Anotação minha')).getByText('Biblioteca')).toBeInTheDocument()
  })

  it('mostra as entradas também, com o que são, e as notas que nasceram delas com "de: <entrada>"', () => {
    put([
      item('Aula 7 em vídeo', { role: 'entrada', origin: VIDEO, at: '2026-11-14T20:00:00.000Z' }),
      item('Monitoria gravada', { role: 'entrada', origin: AUDIO, at: '2026-11-14T19:00:00.000Z' }),
      item('Capítulo 2', { role: 'entrada', origin: PDF, at: '2026-11-14T18:00:00.000Z' }),
      item('Ata da aula 7', { type: 'meeting', parentFileId: 'Aula 7 em vídeo', at: '2026-11-14T21:00:00.000Z' }),
      item('Explicação solta da ata', { type: 'explanation', parentFileId: 'Ata da aula 7', at: '2026-11-14T17:00:00.000Z' }),
    ])
    renderHome()
    expect(within(rowOf('Aula 7 em vídeo')).getByText('Vídeo')).toBeInTheDocument()
    expect(within(rowOf('Monitoria gravada')).getByText('Áudio')).toBeInTheDocument()
    expect(within(rowOf('Capítulo 2')).getByText('PDF')).toBeInTheDocument()
    expect(within(rowOf('Ata da aula 7')).getByText('de: Aula 7 em vídeo')).toBeInTheDocument()
    // a quiet text, not a second link inside the row
    expect(within(rowOf('Ata da aula 7')).queryByRole('link')).toBeNull()
    // only a note born of an entrada says it; the entrada itself and a note born of a note do not
    expect(within(rowOf('Aula 7 em vídeo')).queryByText(/^de:/)).toBeNull()
    expect(within(rowOf('Explicação solta da ata')).queryByText(/^de:/)).toBeNull()
  })

  it('a Lixeira fica de fora, e a aula ainda não escrita também', () => {
    put([item('Viva', { at: '2026-11-14T20:00:00.000Z' }), item('Apagada', { at: '2026-11-15T01:00:00.000Z', deletedAt: '2026-11-15T01:10:00.000Z' }), item('Aula a escrever', { status: 'pending', at: '2026-11-15T01:20:00.000Z' })])
    renderHome()
    expect(rowNames()).toEqual(['Viva'])
  })

  it('o que está sendo gerado mostra "gerando…" na própria linha', () => {
    put([item('Ata em andamento', { type: 'meeting', status: 'generating', at: '2026-11-15T01:45:00.000Z' }), item('Ata pronta', { type: 'meeting', at: '2026-11-15T01:00:00.000Z' })])
    renderHome()
    expect(within(rowOf('Ata em andamento')).getByText('gerando…')).toBeInTheDocument()
    expect(within(rowOf('Ata pronta')).queryByText('gerando…')).toBeNull()
  })

  it('o clique abre a nota, e a entrada abre a página da entrada', () => {
    put([item('nota-1', { name: 'Uma nota', at: '2026-11-14T20:00:00.000Z' }), item('video-1', { name: 'Um vídeo', role: 'entrada', origin: VIDEO, at: '2026-11-14T19:00:00.000Z' })])
    const view = renderHome()
    fireEvent.click(rowOf('Uma nota'))
    expect(screen.getByLabelText('rota')).toHaveTextContent('/arquivo/nota-1')
    view.unmount()
    renderHome()
    fireEvent.click(rowOf('Um vídeo'))
    expect(screen.getByLabelText('rota')).toHaveTextContent('/entrada/video-1')
  })

  it('as outras caixas da tela antiga saíram: revisão, cartões, gravações sem transcrição, continuar lendo, saudação', () => {
    put(week.map(file => ({ ...file, mastery: 40, cardDue: ['2020-01-01'] })))
    renderHome()
    for (const name of ['Para revisar', 'Cartões para hoje', 'Gravações sem transcrição', 'Últimas notas']) expect(screen.queryByRole('region', { name })).toBeNull()
    expect(screen.queryByText('Continuar lendo')).toBeNull()
    expect(screen.queryByText(/^Bom dia|^Boa tarde|^Boa noite/)).toBeNull()
    expect(screen.queryByText(/pede revisão|pedem revisão/)).toBeNull()
    expect(within(home()).queryByRole('button', { name: /Novo conteúdo|Importar/ })).toBeNull()
  })
})

describe('Início: 20 linhas e "Mostrar mais"', () => {
  const many = () =>
    Array.from({ length: 45 }, (_, index) => {
      const minutes = String(index).padStart(2, '0')
      return item(`Nota ${minutes}`, { at: `2026-11-14T15:${minutes}:00.000Z` })
    })

  it('mostra 20, e cada clique traz mais 20 até acabar', () => {
    put(many())
    renderHome()
    const rows = () => within(home()).getAllByRole('button').filter(button => button.querySelector('.hr-name'))
    expect(rows()).toHaveLength(20)
    expect(rows()[0]).toHaveTextContent('Nota 44')
    fireEvent.click(within(home()).getByRole('button', { name: 'Mostrar mais' }))
    expect(rows()).toHaveLength(40)
    fireEvent.click(within(home()).getByRole('button', { name: 'Mostrar mais' }))
    expect(rows()).toHaveLength(45)
    expect(within(home()).queryByRole('button', { name: 'Mostrar mais' })).toBeNull()
  })

  it('com 20 ou menos, não tem "Mostrar mais"', () => {
    put(many().slice(0, 20))
    renderHome()
    expect(within(home()).queryByRole('button', { name: 'Mostrar mais' })).toBeNull()
  })

  it('o corte de 20 vale para a lista toda, e os grupos só mostram o que coube', () => {
    put([...many(), item('Muito antiga', { at: '2026-01-01T12:00:00.000Z' })])
    renderHome()
    expect(groups()).toEqual(['Hoje'])
  })
})

describe('Início com a biblioteca vazia', () => {
  it('uma linha curta e as ações Novo e Gravar', () => {
    put([])
    renderHome()
    const region = home()
    expect(within(region).queryAllByRole('heading', { level: 3 })).toHaveLength(0)
    expect(within(region).getByText(/Nada por aqui ainda/)).toBeInTheDocument()
    fireEvent.click(within(region).getByRole('button', { name: 'Novo' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'new' })
    fireEvent.click(within(region).getByRole('button', { name: 'Gravar' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'record' })
  })

  it('só o que está na Lixeira conta como vazio', () => {
    put([item('Só na Lixeira', { deletedAt: '2026-11-14T20:00:00.000Z' })])
    renderHome()
    expect(within(home()).getByText(/Nada por aqui ainda/)).toBeInTheDocument()
  })

  it('com coisas na biblioteca, não aparece a linha de vazio', () => {
    put([item('Uma nota', { at: '2026-11-14T20:00:00.000Z' })])
    renderHome()
    expect(within(home()).queryByText(/Nada por aqui ainda/)).toBeNull()
    expect(FOLDERS.length).toBeGreaterThan(0)
  })
})
