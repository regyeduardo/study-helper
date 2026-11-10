import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { AiConfig, MapArtifact, MapDiagram, SharedItem } from '@/types/domain'
import { MindMapDialog } from '@/components/dialogs/MindMapDialog'
import { newMapArtifact } from '@/lib/artifacts'
import { MAP_CHAT_PROMPT } from '@/lib/generation/map-chat'
import { nowIso } from '@/lib/ids'
import { useLibraryStore } from '@/stores/library'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'
import { studyLibrary, studyNote } from '@/test/generation/study-fixture'

// jsdom has no layout (no getBBox), so the real Mermaid cannot draw here: this one records the code and hands back an SVG shaped like Mermaid's.
const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (_id: string, _code: string) => ({
    svg: '<svg id="m" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 400px;" viewBox="0 0 400 200"><g/></svg>',
  })),
}))
vi.mock('mermaid', () => ({ default: mermaid }))

const mine = {
  id: 'mine',
  type: 'custom' as const,
  name: 'Minha IA',
  key: 'k',
  base: 'https://api.exemplo.dev/v1',
}
const A = {
  uid: 'mine::modelo-a',
  pid: 'mine',
  mid: 'modelo-a',
  name: 'Modelo A',
}
const B = {
  uid: 'mine::modelo-b',
  pid: 'mine',
  mid: 'modelo-b',
  name: 'Modelo B',
}

const DIAGRAM: MapDiagram = {
  form: 'arvore',
  root: {
    id: 'r',
    text: 'Limites',
    children: [
      { id: 'a', text: 'Laterais', children: [] },
      { id: 'b', text: 'Continuidade', children: [] },
    ],
  },
}

/** The map as the chat AI sees it: short ids n1 (root), n2 (Laterais), n3 (Continuidade). */
const changed = (laterais: string, continuidade: string) => ({
  id: 'n1',
  texto: 'Limites',
  filhos: [
    { id: 'n2', texto: laterais, filhos: [] },
    { id: 'n3', texto: continuidade, filhos: [] },
  ],
})

let replies: string[] = []
let calls: CapturedRequest[] = []

beforeEach(() => {
  replies = []
  mermaid.render.mockClear()
  calls = installFetch(request => {
    if (systemPromptOf(request) !== MAP_CHAT_PROMPT) return new Response('chamada inesperada', { status: 500 })
    const reply = replies.shift()
    return reply === undefined ? new Response('sem resposta combinada', { status: 500 }) : openAiStream(reply)
  }).calls
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function withConfig(aiConfig: AiConfig) {
  useLibraryStore.setState(state => ({
    index: { ...state.index, settings: { ...state.index.settings, aiConfig } },
  }))
}

async function openMap(made?: { model?: string }) {
  const memory = studyLibrary()
  const id = await studyNote()
  await useLibraryStore.getState().saveArtifact(
    id,
    newMapArtifact({
      name: 'Limites e continuidade',
      diagram: DIAGRAM,
      made: { ...made, at: nowIso() },
    }),
  )
  render(<MindMapDialog fileId={id} />)
  await screen.findByRole('list', { name: 'Itens do mapa' })
  const maps = () => (memory.sidecars.get(id)?.artifacts ?? []).filter((item): item is MapArtifact => item.kind === 'mapa')
  return { id, maps, map: () => maps()[0] }
}

const items = () => within(screen.getByRole('list', { name: 'Itens do mapa' }))
const talk = () => within(screen.getByRole('list', { name: 'Conversa do mapa' }))
const undoButton = () => screen.getByRole('button', { name: 'Desfazer' })
const drawn = () => String(mermaid.render.mock.calls.at(-1)?.[1] ?? '')

async function send(text: string, reply: unknown) {
  replies.push(typeof reply === 'string' ? reply : JSON.stringify(reply))
  fireEvent.change(screen.getByRole('textbox', { name: 'Pergunte ou peça uma mudança' }), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled())
}

describe('the map screen with its chat', () => {
  it('opens on the map, with the name, the drawing and "Desfazer" off while there is no version', async () => {
    await openMap()
    expect(
      screen.getByRole('dialog', {
        name: 'Mapa mental: Limites e continuidade',
      }),
    ).toBeInTheDocument()
    expect(items().getByText('Laterais')).toBeInTheDocument()
    await waitFor(() => expect(drawn()).toContain('Laterais'))
    expect(undoButton()).toBeDisabled()
  })

  it('the conversation is read aloud as it grows', async () => {
    await openMap()
    expect(screen.getByRole('list', { name: 'Conversa do mapa' })).toHaveAttribute('aria-live', 'polite')
  })

  it('collapsed, the whole strip opens the conversation again', async () => {
    await openMap()
    fireEvent.click(screen.getByRole('button', { name: 'Recolher a conversa' }))
    const strip = screen.getByRole('button', { name: 'Abrir a conversa' })
    expect(strip).toHaveTextContent('Conversa')
    fireEvent.click(strip)
    expect(screen.getByRole('textbox', { name: 'Pergunte ou peça uma mudança' })).toBeInTheDocument()
  })

  it('a question answers in the chat and leaves the map as it was', async () => {
    const { map } = await openMap()
    await send('O que são os laterais?', {
      resposta: 'São os limites pela esquerda e pela direita.',
      mapa: null,
    })
    expect(await talk().findByText('São os limites pela esquerda e pela direita.')).toBeInTheDocument()
    expect(talk().getByText('O que são os laterais?')).toBeInTheDocument()
    await waitFor(() => expect(map().chat).toHaveLength(2))
    expect(map()).toMatchObject({ diagram: DIAGRAM, versions: [] })
    expect(map().chat[1]).not.toHaveProperty('changed')
    expect(items().getByText('Laterais')).toBeInTheDocument()
    expect(undoButton()).toBeDisabled()
  })

  it('a change request redraws the map at once, makes the changed branch blink and keeps a version', async () => {
    const { map } = await openMap()
    await send('Deixa claro que são limites laterais', {
      resposta: 'Pronto, renomeei o ramo.',
      mapa: changed('Limites laterais', 'Continuidade'),
    })
    expect(await items().findByText('Limites laterais')).toHaveClass('pisca')
    expect(items().getByText('Continuidade')).not.toHaveClass('pisca')
    expect(talk().getByText('Mudei 1 ramo')).toBeInTheDocument()
    await waitFor(() => expect(drawn()).toMatch(/class m1 pisca/))
    expect(drawn()).toContain('Limites laterais')
    await waitFor(() => expect(map().versions).toEqual([DIAGRAM]))
    expect(map()).toMatchObject({
      highlight: ['a'],
      chat: [{ who: 'você' }, { who: 'ia', changed: ['a'] }],
    })
    expect(undoButton()).toBeEnabled()
  })

  it('the blink lasts until the next request', async () => {
    const { map } = await openMap()
    await send('Renomeia os laterais', {
      resposta: 'Renomeei.',
      mapa: changed('Limites laterais', 'Continuidade'),
    })
    expect(await items().findByText('Limites laterais')).toHaveClass('pisca')
    await send('E agora?', { resposta: 'Nada mudou.', mapa: null })
    await talk().findByText('Nada mudou.')
    expect(items().getByText('Limites laterais')).not.toHaveClass('pisca')
    await waitFor(() => expect(map().highlight).toBeUndefined())
  })

  it('"Desfazer" goes back one step at a time and turns off with no versions left', async () => {
    const { map } = await openMap()
    await send('Renomeia os laterais', {
      resposta: 'Renomeei os laterais.',
      mapa: changed('Limites laterais', 'Continuidade'),
    })
    await items().findByText('Limites laterais')
    await send('Explica a continuidade', {
      resposta: 'Expliquei a continuidade.',
      mapa: changed('Limites laterais', 'Continuidade exige limite igual ao valor'),
    })
    await items().findByText('Continuidade exige limite igual ao valor')
    await waitFor(() => expect(map().versions).toHaveLength(2))

    fireEvent.click(undoButton())
    expect(await items().findByText('Continuidade')).not.toHaveClass('pisca')
    expect(items().getByText('Limites laterais')).toBeInTheDocument()
    await waitFor(() => expect(map().versions).toHaveLength(1))
    expect(undoButton()).toBeEnabled()

    fireEvent.click(undoButton())
    expect(await items().findByText('Laterais')).toBeInTheDocument()
    await waitFor(() => expect(map()).toMatchObject({ diagram: DIAGRAM, versions: [] }))
    expect(undoButton()).toBeDisabled()
    expect(map().chat).toHaveLength(4)
  })

  it('"Desfazer" in the answer undoes that change', async () => {
    const { map } = await openMap()
    await send('Renomeia os laterais', {
      resposta: 'Renomeei.',
      mapa: changed('Limites laterais', 'Continuidade'),
    })
    fireEvent.click(await talk().findByRole('button', { name: 'Desfazer esta mudança' }))
    expect(await items().findByText('Laterais')).toBeInTheDocument()
    await waitFor(() => expect(map().versions).toEqual([]))
    expect(talk().queryByRole('button', { name: 'Desfazer esta mudança' })).not.toBeInTheDocument()
  })

  it('"Salvar como outro mapa" keeps both: the new one has the drawing of now and no conversation', async () => {
    const { maps } = await openMap()
    await send('Renomeia os laterais', {
      resposta: 'Renomeei.',
      mapa: changed('Limites laterais', 'Continuidade'),
    })
    await items().findByText('Limites laterais')
    fireEvent.click(screen.getByRole('button', { name: 'Salvar como outro mapa' }))
    await waitFor(() => expect(maps()).toHaveLength(2))
    const [original, copy] = maps()
    expect(original.chat).toHaveLength(2)
    expect(copy).toMatchObject({
      name: 'Limites e continuidade (cópia)',
      chat: [],
      versions: [],
    })
    expect(copy.id).not.toBe(original.id)
    expect(copy.diagram).toEqual(original.diagram)
    expect(copy.highlight).toBeUndefined()
    expect(await screen.findByRole('button', { name: 'Mapas desta nota (2)' })).toBeInTheDocument()
    expect(talk().getByText('Renomeei.')).toBeInTheDocument()
  })

  it('an answer out of format shows the reason and keeps the map and what was typed', async () => {
    const { map } = await openMap()
    await send('Junta tudo', 'isto não é JSON')
    expect(await screen.findByText('A IA respondeu fora do formato esperado. Tente de novo.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Pergunte ou peça uma mudança' })).toHaveValue('Junta tudo')
    await send('Junta tudo', {
      resposta: 'Juntei.',
      mapa: { texto: '', filhos: [] },
    })
    expect(await screen.findByText('A IA devolveu um mapa sem centro. Tente pedir de novo.')).toBeInTheDocument()
    expect(items().getByText('Laterais')).toBeInTheDocument()
    expect(map()).toMatchObject({ diagram: DIAGRAM, versions: [], chat: [] })
    expect(undoButton()).toBeDisabled()
  })

  it('the chat starts on the model that made the map, and a model changed there goes to the next request', async () => {
    studyLibrary()
    withConfig({
      providers: [mine],
      models: [A, B],
      defaults: { estudo: A.uid },
      steps: {},
    })
    const id = await studyNote()
    await useLibraryStore.getState().saveArtifact(
      id,
      newMapArtifact({
        name: 'Limites e continuidade',
        diagram: DIAGRAM,
        made: { model: B.uid, at: nowIso() },
      }),
    )
    render(<MindMapDialog fileId={id} />)
    await screen.findByRole('list', { name: 'Itens do mapa' })
    expect(screen.getByLabelText('Modelo')).toHaveValue(B.uid)
    await send('O que são os laterais?', {
      resposta: 'Esquerda e direita.',
      mapa: null,
    })
    await talk().findByText('Esquerda e direita.')
    expect(calls.at(-1)?.body?.model).toBe('modelo-b')
    fireEvent.change(screen.getByLabelText('Modelo'), {
      target: { value: A.uid },
    })
    await send('E a continuidade?', {
      resposta: 'Limite igual ao valor.',
      mapa: null,
    })
    await talk().findByText('Limite igual ao valor.')
    expect(calls.at(-1)?.body?.model).toBe('modelo-a')
  })

  it('a map with no model of its own starts on the default of Mapa mental', async () => {
    studyLibrary()
    withConfig({
      providers: [mine],
      models: [A, B],
      defaults: { estudo: B.uid },
      steps: {},
    })
    const id = await studyNote()
    await useLibraryStore.getState().saveArtifact(id, newMapArtifact({ name: 'Limites e continuidade', diagram: DIAGRAM }))
    render(<MindMapDialog fileId={id} />)
    expect(await screen.findByLabelText('Modelo')).toHaveValue(B.uid)
  })
})

describe('a map opened from a share link', () => {
  afterEach(() => {
    useLibraryStore.getState().leaveShared()
  })

  it('shows the drawing and the exports, but neither the chat nor anything that changes the map', async () => {
    studyLibrary()
    const item = {
      version: 1,
      id: 'link-1',
      kind: 'file',
      title: 'Limites',
      createdAt: '2026-11-05T10:00:00.000Z',
      expiresAt: '2026-12-05T10:00:00.000Z',
      folders: [],
      files: [
        {
          id: 'f1',
          name: 'Limites',
          folderId: null,
          type: 'class',
          position: 0,
          description: '',
          tags: [],
          content: '# Limites',
          questions: [],
          highlights: [],
          artifacts: [
            {
              id: 'm1',
              kind: 'mapa',
              name: 'Limites e continuidade',
              diagram: DIAGRAM,
              mermaid: '',
            },
          ],
        },
      ],
    } as SharedItem
    useLibraryStore.getState().enterShared(item, {})
    render(<MindMapDialog fileId="f1" />)
    expect(
      await screen.findByRole('dialog', {
        name: 'Mapa mental: Limites e continuidade',
      }),
    ).toBeInTheDocument()
    expect(items().getByText('Laterais')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Exportar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aumentar' })).toBeInTheDocument()
    for (const name of ['Desfazer', 'Salvar como outro mapa', 'Gerar de novo…', 'Renomear o mapa', 'Enviar']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Conversa do mapa' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})

describe('the drawing of the map', () => {
  it('zooms in and out from the buttons and "Ajustar" fits it again', async () => {
    await openMap()
    const svg = await waitFor(() => {
      const found = document.querySelector('.map-canvas svg')
      if (!found) throw new Error('sem desenho')
      return found
    })
    expect(screen.getByText('100%')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Aumentar' }))
    expect(screen.getByText('125%')).toBeInTheDocument()
    expect(document.querySelector('.map-canvas svg')).toBe(svg)
    expect(svg).toHaveAttribute('width', '500')
    fireEvent.click(screen.getByRole('button', { name: 'Diminuir' }))
    fireEvent.click(screen.getByRole('button', { name: 'Diminuir' }))
    expect(screen.getByText('80%')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ajustar à tela' }))
    expect(screen.getByText('100%')).toBeInTheDocument()
  })

  it('the drawing takes the keyboard focus, so the arrows move around a zoomed map', async () => {
    await openMap()
    const drawing = await screen.findByRole('img', { name: 'Desenho do mapa' })
    expect(drawing).toHaveAttribute('tabindex', '0')
    expect(drawing.querySelector('svg')).not.toBeNull()
  })

  it('when Mermaid cannot draw, the map shows as a list instead of a broken drawing', async () => {
    mermaid.render.mockRejectedValueOnce(new Error('Parse error'))
    await openMap()
    expect(await screen.findByText('Não consegui desenhar este mapa. Os itens estão em lista.')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Itens do mapa' })).not.toHaveClass('sr-only')
    expect(document.querySelector('.map-canvas svg')).toBeNull()
  })
})

describe('the map on the phone (FR-054)', () => {
  // a map far bigger than the screen: fitting it whole would leave the letters at 13%
  const BIG = '<svg id="m" width="100%" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2400 1400"><g class="root"><g class="node default" id="map-view-9-flowchart-m0-0"><rect/></g></g></svg>'
  const SCREEN = { width: 358, height: 520 }
  const spies: { mockRestore(): void }[] = []

  beforeEach(() => {
    mermaid.render.mockImplementation(async () => ({ svg: BIG }))
    // jsdom has no layout: the canvas gets the size of a phone and the center of the map sits at (1200, 700) of the drawing
    const sized = (side: 'clientWidth' | 'clientHeight', value: number) =>
      vi.spyOn(HTMLElement.prototype, side, 'get').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('map-canvas') ? value : 0
      })
    spies.push(
      sized('clientWidth', SCREEN.width),
      sized('clientHeight', SCREEN.height),
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const canvas = this.closest('.map-canvas') as HTMLElement | null
        if (!canvas || !this.matches('[id$="flowchart-m0-0"]')) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
        const zoom = Number(canvas.querySelector('svg')?.getAttribute('width')) / 2400
        const left = 24 + 1120 * zoom - canvas.scrollLeft
        const top = 24 + 670 * zoom - canvas.scrollTop
        return { left, top, width: 160 * zoom, height: 60 * zoom, right: left + 160 * zoom, bottom: top + 60 * zoom, x: left, y: top, toJSON: () => ({}) } as DOMRect
      }),
    )
  })

  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore()
    mermaid.render.mockImplementation(async () => ({ svg: '<svg id="m" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 400px;" viewBox="0 0 400 200"><g/></svg>' }))
  })

  function phone() {
    spies.push(
      vi.spyOn(window, 'matchMedia').mockImplementation(
        query =>
          ({
            matches: query.includes('max-width'),
            media: query,
            onchange: null,
            addListener: () => undefined,
            removeListener: () => undefined,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            dispatchEvent: () => false,
          }) as MediaQueryList,
      ),
    )
  }

  /** jsdom has no PointerEvent: a mouse event with the pointer's id and kind is what React reads. */
  function finger(canvas: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', id: number, x: number, y: number, kind = 'touch') {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
    Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: kind } })
    fireEvent(canvas, event)
  }
  const tap = (canvas: Element, id: number, x: number, y: number, kind?: string) => {
    finger(canvas, 'pointerdown', id, x, y, kind)
    finger(canvas, 'pointerup', id, x, y, kind)
  }

  async function drawnMap() {
    await openMap()
    const canvas = await screen.findByRole('img', { name: 'Desenho do mapa' })
    await waitFor(() => expect(canvas.querySelector('svg')).not.toBeNull())
    return canvas
  }
  const fit = () => screen.getByRole('button', { name: 'Ajustar à tela' })

  it('opens legible, at 100% on the center of the map, never shrunk to fit the screen', async () => {
    phone()
    const canvas = await drawnMap()
    await waitFor(() => expect(screen.getByText('100%')).toBeInTheDocument())
    expect(fit()).toHaveAttribute('aria-pressed', 'false')
    // the center of the map (1224, 724 in the canvas) in the middle of the screen
    expect(canvas.scrollLeft).toBe(1224 - SCREEN.width / 2)
    expect(canvas.scrollTop).toBe(724 - SCREEN.height / 2)
  })

  it('on the computer the same map still opens fitted to the screen, and a mouse double click does not zoom', async () => {
    const canvas = await drawnMap()
    await waitFor(() => expect(screen.getByText('13%')).toBeInTheDocument())
    expect(fit()).toHaveAttribute('aria-pressed', 'true')
    tap(canvas, 1, 100, 100, 'mouse')
    tap(canvas, 1, 100, 100, 'mouse')
    expect(screen.getByText('13%')).toBeInTheDocument()
  })

  it('two fingers pinch the zoom and one finger drags the map', async () => {
    phone()
    const canvas = await drawnMap()
    await waitFor(() => expect(screen.getByText('100%')).toBeInTheDocument())
    finger(canvas, 'pointerdown', 1, 100, 200)
    finger(canvas, 'pointerdown', 2, 200, 200)
    finger(canvas, 'pointermove', 2, 300, 200)
    expect(screen.getByText('200%')).toBeInTheDocument()
    finger(canvas, 'pointerup', 2, 300, 200)
    const { scrollLeft, scrollTop } = canvas
    finger(canvas, 'pointermove', 1, 60, 150)
    expect(canvas.scrollLeft).toBe(scrollLeft + 40)
    expect(canvas.scrollTop).toBe(scrollTop + 50)
    finger(canvas, 'pointerup', 1, 60, 150)
    expect(screen.getByText('200%')).toBeInTheDocument()
  })

  it('a double tap fits the whole map, and another zooms in where it was tapped', async () => {
    phone()
    const canvas = await drawnMap()
    await waitFor(() => expect(screen.getByText('100%')).toBeInTheDocument())
    tap(canvas, 1, 150, 300)
    tap(canvas, 2, 154, 296)
    await waitFor(() => expect(screen.getByText('13%')).toBeInTheDocument())
    expect(fit()).toHaveAttribute('aria-pressed', 'true')
    canvas.scrollLeft = 0
    canvas.scrollTop = 0
    tap(canvas, 3, 150, 300)
    tap(canvas, 4, 150, 300)
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(fit()).toHaveAttribute('aria-pressed', 'false')
    // the point under the finger stays under it: 150 px of a map at 13% is 1161 px at 100%
    const ratio = 1 / (SCREEN.width - 48) / (1 / 2400)
    expect(canvas.scrollLeft).toBeCloseTo(150 * ratio - 150, 0)
    expect(canvas.scrollTop).toBeCloseTo(300 * ratio - 300, 0)
    // two taps far apart are no double tap
    tap(canvas, 5, 40, 40)
    tap(canvas, 6, 300, 480)
    expect(screen.getByText('100%')).toBeInTheDocument()
  })

  it('every action of the map and of the chat is a target of at least 36 px on the phone', () => {
    const css = readFileSync(path.resolve(__dirname, '../../styles/app.css'), 'utf8')
    const section = css.slice(css.indexOf('/* Mapa com chat */'), css.indexOf('/* Lista de artefatos */'))
    const onPhone = section.slice(section.indexOf('@media (max-width:760px)'))
    const sizeOf = (selector: string) => {
      const rule = new RegExp(`(?:^|[},\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{]*\\{([^}]*)\\}`).exec(onPhone)?.[1] ?? ''
      return Number(/(?:min-)?height:(\d+)px/.exec(rule)?.[1] ?? 0)
    }
    expect(sizeOf('.map-handle')).toBeGreaterThanOrEqual(36)
    expect(sizeOf('.map-starters .chip')).toBeGreaterThanOrEqual(36)
    expect(sizeOf('.map-scrim .menu .mi')).toBeGreaterThanOrEqual(36)
    // side by side, at least 8 px apart, so a thumb does not hit the neighbor
    const gapOf = (selector: string) => Number(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{[^}]*gap:(\\d+)px`).exec(onPhone)?.[1] ?? 0)
    expect(gapOf('.map-zoom')).toBeGreaterThanOrEqual(8)
    expect(gapOf('.map-starters')).toBeGreaterThanOrEqual(8)
  })
})
