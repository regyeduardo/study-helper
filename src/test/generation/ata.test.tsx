import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
}))

import { AtaPartsDialog } from '@/components/dialogs/AtaPartsDialog'
import { ItemMenu } from '@/components/library/ItemMenu'
import { DocumentBody } from '@/components/reader/DocumentArticle'
import { MeetingTabs } from '@/components/reader/MeetingTabs'
import { Cancelled } from '@/controllers/ai.controller'
import { defaultIndex } from '@/lib/defaults'
import { buildAta, withImages } from '@/lib/generation/ata'
import { appAi, passSettings, withRetry } from '@/lib/generation/ata-ai'
import * as P from '@/lib/generation/ata-prompts'
import { jsonIn, linkMoments } from '@/lib/generation/meeting-material'
import { sampleTimes } from '@/lib/generation/screen-reading'
import { shapePart } from '@/lib/generation/summary'
import { clipQuote, enforce, saidIn, unowned, voteDecisions } from '@/lib/generation/tasks'
import type { Repository } from '@/lib/storage/repository'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { installFetch, openAiStream, sseResponse, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'
import { fakeAi, fakeFrames, meeting, textAnswer } from '@/test/generation/ata-fixture'
import type { FileSidecar, Settings } from '@/types/domain'

const startedAt = new Date(2026, 9, 28, 18, 15)
const difference = (a: number[], b: number[]) => Math.abs(a[0] - b[0])
const renderPrint = vi.fn(async (_image: string, _marks: unknown[], caption: string) => `data:image/jpeg;base64,PRINT ${caption}`)

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('pieces of the passes', () => {
  it('reads JSON cut by max_tokens and drops <think>', () => {
    expect(jsonIn('<think>x</think>```json\n{"a": [1, 2], "b": {"c": "d"}}```')).toEqual({ a: [1, 2], b: { c: 'd' } })
    expect(jsonIn('{"tarefas": [{"o_que": "um"}, {"o_que": "do')).toEqual({ tarefas: [{ o_que: 'um' }] })
    expect(jsonIn('sem json')).toBeNull()
  })

  it('turns [▸ mm:ss] into links that play the media', () => {
    expect(linkMoments('ok [▸ 01:05] e [▸ 2:00, 03:01]')).toBe('ok [▸ 01:05](#t=65) e [▸ 02:00](#t=120) [▸ 03:01](#t=181)')
    expect(linkMoments('já [▸ 01:05](#t=65)')).toBe('já [▸ 01:05](#t=65)')
  })

  const said = saidIn(['Natália, ajusta a Tabela de Vendas até amanhã.', 'Deixa comigo, eu ajusto amanhã.'])

  it('a task needs a quote that really was said (3+ words); screen text never said does not count', () => {
    expect(said.some('ajusta a tabela de vendas...')).toBe(true)
    expect(said.some('Versão Duque de Caxias')).toBe(false)
    expect(said.all('ajusta a Tabela ... eu ajusto amanhã')).toBe(true)
    expect(said.all('ajusta a Tabela ... cartão #009')).toBe(false)
  })

  it('enforce: no speech proof drops the task; "aceita" needs the owner\'s own words; Base keeps literal quotes only', () => {
    const task = { manter: true, dono: 'Natália Lenza', situacao: 'aceita', prova_fala: { minuto: '00:30', quem: 'Henrique Souza', citacao: 'ajusta a Tabela de Vendas' }, aceite: { minuto: '01:00', quem: 'Natália Lenza', citacao: 'Deixa comigo, eu ajusto' }, base: [{ minuto: '00:30', citacao: 'ajusta a Tabela de Vendas' }, { minuto: '02:00', citacao: 'texto do cartão na tela' }] }
    expect(enforce(task, said)).toMatchObject({ situacao: 'aceita', base: [{ minuto: '00:30' }] })
    expect(enforce({ ...task, aceite: { ...task.aceite, quem: 'Henrique Souza' } }, said).situacao).toBe('pedida')
    expect(enforce({ ...task, aceite: null }, said).situacao).toBe('pedida')
    expect(enforce({ ...task, prova_fala: { citacao: 'Versão Duque de Caxias' }, base: [] }, said).manter).toBe(false)
  })

  it('the reviewer is a majority of 5 votes; without majority the task stays', () => {
    const v = (decisao: string, de = 0) => [{ n: 1, decisao, de }]
    expect(voteDecisions([v('sai'), v('sai'), v('sai'), v('fica'), v('fica')], 1)[0]).toMatchObject({ decisao: 'sai', votos: 3 })
    expect(voteDecisions([v('sai'), v('sai'), v('fica'), v('fica'), []], 1)[0]).toMatchObject({ decisao: 'fica', motivo: 'sem maioria' })
  })

  it('quotes over 110 characters are cut at a word boundary and stay literal', () => {
    const long = 'palavra '.repeat(20).trim()
    expect(clipQuote(long).length).toBeLessThanOrEqual(103)
    expect(clipQuote(long)).toMatch(/^palavra( palavra)*\.\.\.$/)
    expect(clipQuote('curta')).toBe('curta')
  })

  it('"Ficou sem dono" drops items equal to a task, with non-literal quotes, or already cited by a task', () => {
    const pending = { divergencias: [{ assunto: 'A', igual_a_tarefa: 0, base: [{ minuto: '01:00', citacao: 'Deixa comigo, eu ajusto' }] }], vai_ter: [{ assunto: 'B', igual_a_tarefa: 2, base: [{ minuto: '00:30', citacao: 'ajusta a Tabela de Vendas' }] }], cobrancas_de_fora: [{ assunto: 'C', igual_a_tarefa: 0, base: [{ minuto: '03:00', citacao: 'ninguém disse isso nunca' }] }] }
    expect(unowned(pending, [], said).map(item => item.assunto)).toEqual(['A'])
    expect(unowned(pending, ['**Base:** [▸ 01:00] "Deixa comigo"'], said)).toEqual([])
  })

  it('a BASE part loses its title and goes one level down, prints become image slots', () => {
    const part = shapePart('> Encaixe: bom — x\n# Título\n\n## Em poucas linhas\nTexto [▸ 00:30]\n{{print 00:40 | o campo}}', 'resumo')
    expect(part.title).toBe('Título')
    expect(part.markdown).toBe('### Em poucas linhas\nTexto [▸ 00:30]\n{{img:resumo-1.jpg}}\n')
    expect(part.prints).toEqual([{ name: 'resumo-1.jpg', at: 40, marcar: 'o campo', legenda: 'o campo' }])
  })

  it('samples the video every 5 s, or uses the scene list when there is one', () => {
    expect(sampleTimes(20)).toEqual([1, 6, 11, 16])
    expect(sampleTimes(20, [0.5, 3, 3, 12])).toEqual([3, 12])
  })
})

describe('the Ata pipeline', () => {
  it('names the voices from the call tiles: the microphone gets the remaining name, never "Você"', async () => {
    const done = await buildAta({ recording: meeting, parts: ['resumo'], startedAt }, { ai: fakeAi(), frames: fakeFrames(), difference, renderPrint })
    expect(done.recording.speakers.map(speaker => speaker.name)).toEqual(['Regy Niles', 'Henrique Souza', 'Natália Lenza'])
    expect(done.markdown).not.toMatch(/Você|Falante \d/)
    expect(done.markdown).toContain('> Participantes: Henrique Souza, Natália Lenza e Regy Niles (gravou).')
  })

  it('only the checked parts, in the fixed order, in ONE document with minute links, anchors and prints', async () => {
    const ai = fakeAi()
    const frames = fakeFrames()
    const done = await buildAta({ recording: meeting, parts: ['tarefas', 'resumo'], startedAt }, { ai, frames, difference, renderPrint })
    const md = done.markdown
    expect(md.indexOf('## Resumo')).toBeGreaterThan(0)
    expect(md.indexOf('## Levantamento de tarefas')).toBeGreaterThan(md.indexOf('## Resumo'))
    expect(md).not.toContain('## Perguntas em aberto')
    expect(md).toContain('# Tabela de Vendas (HM)')
    expect(md).toContain('- [ ] [Ajustar a Tabela de Vendas (card #007)](#t1) · Natália Lenza · 29/10/2026')
    expect(md).toContain('<a id="t1"></a>\n#### 1. Ajustar a Tabela de Vendas (card #007)')
    expect(md).toContain('[▸ 00:30](#t=30)')
    expect(md).toContain('### Ficou sem dono')
    expect(md).toContain('### Glossário')
    expect(md).toContain('**VGV:** Valor Geral de Vendas. A transcrição escreve BGV.')
    expect(md).not.toMatch(/Você|Falante \d/)
    expect(md).not.toContain('{{')
    // only on screen, nobody spoke of it: out
    expect(md).not.toContain('Duque de Caxias')
    // prints: drawn, stored and referenced
    expect(md).toContain('![Campos a alinhar](imagens/t1-1.jpg)')
    expect(md).toContain('![campo Valor ticket médio](imagens/resumo-1.jpg)')
    expect(done.images.map(image => image.name).sort()).toEqual(['resumo-1.jpg', 't1-1.jpg'])
    expect(renderPrint).toHaveBeenCalledWith('data:image/jpeg;base64,crop-40', [{ box: [100, 100, 300, 200], label: 'Valor ticket médio' }], '▸ 00:40 · Campos a alinhar')
    // the screen was read only inside the shared area found by the vision model
    expect(ai.calls.filter(call => call.system === P.LER_TELA).length).toBeGreaterThan(0)
    expect(ai.calls.find(call => call.system === P.ENTENDER)!.user).toContain('00:01–05:01 | HM · Tabela de Vendas · campos: Valor ticket médio=288.837,14')
    expect(frames.crops.every(box => box.x === 376 && box.y === 264 && box.w === 976 && box.h === 714)).toBe(true)
    expect(withImages(md, done.images)).toContain('](data:image/jpeg;base64,PRINT ▸ 00:40 · Campos a alinhar)')
    expect(done.stages.map(stage => stage.stage)).toEqual(expect.arrayContaining(['Quem fala (quadros da chamada)', 'Ler a tela compartilhada', 'Contexto e glossário', 'Resumo', 'Levantamento de tarefas', 'Prints marcados']))
  })

  it('a print asked at the end of a line becomes the image too; one that was not made leaves no slot', async () => {
    const answer = (system: string, user: string) =>
      system.startsWith(P.BASE) && system.endsWith(P.RESUMO) ? '# Curva de vendas\n\n## Pontos principais\n- Curva validada. [▸ 00:30] {{print 00:40 | campo Valor ticket médio}}\n- Menu de Terreno. [▸ 01:00] {{print 01:00 | menu}}' : textAnswer(system, user)
    const ai = fakeAi({ text: answer })
    const made = vi.fn(async (_image: string, _marks: unknown[], caption: string) => (caption.includes('menu') ? Promise.reject(new Error('sem print')) : `data:image/jpeg;base64,PRINT ${caption}`))
    const done = await buildAta({ recording: meeting, parts: ['resumo'], startedAt }, { ai, frames: fakeFrames(), difference, renderPrint: made })
    expect(done.markdown).toContain('![campo Valor ticket médio](imagens/resumo-1.jpg)')
    expect(done.markdown).not.toContain('{{')
  })

  it('a part whose AI keeps failing says why, and the other parts still come out', async () => {
    const answer = (system: string, user: string) => (system === P.CANDIDATAS ? Promise.reject(new Error('A IA respondeu vazio ou sem JSON legível.')) : textAnswer(system, user))
    const done = await buildAta({ recording: meeting, parts: ['resumo', 'tarefas'], startedAt }, { ai: fakeAi({ vision: false, text: answer }), frames: null, difference, renderPrint })
    expect(done.markdown).toContain('Henrique Souza pediu o ajuste da Tabela de Vendas')
    expect(done.markdown).toContain('> Esta parte não saiu: A IA respondeu vazio ou sem JSON legível. Use "Refazer a Ata" para tentar de novo.')
    expect(done.markdown).not.toContain('Nenhuma tarefa apareceu')
  })

  it('every part shares the context pass and uses real names; audio only means no vision and no prints', async () => {
    const ai = fakeAi({ vision: false })
    const named = { ...meeting, speakers: [{ id: 'mic', name: 'Regy Niles', suggested: false }, ...meeting.speakers.slice(1).map((s, i) => ({ ...s, name: ['Henrique Souza', 'Natália Lenza'][i] }))] }
    const done = await buildAta({ recording: named, parts: ['um-a-um', 'linha', 'perguntas', 'resumo', 'tarefas'], startedAt }, { ai, frames: null, difference, renderPrint })
    const order = ['## Resumo', '## Levantamento de tarefas', '## Perguntas em aberto', '## Linha do tempo', '## 1:1'].map(head => done.markdown.indexOf(head))
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]))).toBe(true)
    expect(ai.calls.filter(call => call.system === P.ENTENDER)).toHaveLength(1)
    expect(ai.calls.some(call => call.pass === 'vision')).toBe(false)
    expect(done.images).toEqual([])
    expect(done.markdown).not.toContain('imagens/')
    expect(done.markdown).toContain('#### 00:30 · Tabela de Vendas')
  })

  it('cancel stops the pipeline', async () => {
    const ai = fakeAi({ text: () => Promise.reject(new Cancelled()) })
    await expect(buildAta({ recording: meeting, parts: ['resumo'], startedAt }, { ai, frames: null, difference, renderPrint })).rejects.toBeInstanceOf(Cancelled)
  })
})

describe('the AI of the passes', () => {
  const settings = (): Settings => ({ ...defaultIndex().settings, ai: { provider: 'custom', baseUrl: 'https://ia.exemplo.dev/v1', apiKey: 'k', model: 'modelo-geral' } })

  it('a pass uses its own model when set in Configurações, the Geral model otherwise, same provider and key', async () => {
    const chosen = { ...settings(), aiPasses: { review: 'Qwen/Qwen3.7-Max' } }
    expect(passSettings(chosen, 'review')).toEqual({ provider: 'custom', baseUrl: 'https://ia.exemplo.dev/v1', apiKey: 'k', model: 'Qwen/Qwen3.7-Max' })
    const { calls } = installFetch(() => openAiStream('{"ok": true}'))
    const ai = appAi(chosen)
    await ai.text('review', P.REVISAR, 'lista')
    await ai.text('context', P.ENTENDER, 'falas')
    expect(calls.map(call => call.body?.model)).toEqual(['Qwen/Qwen3.7-Max', 'modelo-geral'])
    expect(calls[0].body?.temperature).toBe(0.2)
    expect(calls[0].headers.authorization).toBe('Bearer k')
    expect(ai.models()).toEqual({ review: 'Qwen/Qwen3.7-Max', context: 'modelo-geral' })
  })

  it('an empty reply, or JSON nobody can read, is asked again (DeepSeek in JSON mode sometimes answers empty)', async () => {
    const replies = ['', '   ', 'não sei', '{"tarefas": [{"o_que": "Ajustar a Tabela de Vendas"}]}', '', '## Resumo']
    const { calls } = installFetch(() => openAiStream(replies.shift() ?? ''))
    const ai = appAi(settings(), undefined, { text: 1000, vision: 1000, backoffMs: 1 })
    expect(JSON.parse(await ai.text('candidates', P.CANDIDATAS, 'falas', { json: true })).tarefas).toHaveLength(1)
    expect(calls).toHaveLength(4)
    expect(await ai.text('write', 'Escreva o resumo', 'falas')).toBe('## Resumo')
    expect(calls).toHaveLength(6)
  })

  it('DeepSeek (deepseek-flash): no JSON mode, and a reply eaten by the thinking is asked again with double the limit', async () => {
    const thinking = sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'pensando muito...' } }] })}\n\n`, `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`, 'data: [DONE]\n\n'])
    let first = true
    const { calls } = installFetch(() => (first ? ((first = false), thinking) : openAiStream('{"tarefas": []}')))
    const deepseek: Settings = { ...defaultIndex().settings, ai: { provider: 'custom', baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-flash' } }
    expect(await appAi(deepseek, undefined, { text: 1000, vision: 1000, backoffMs: 1 }).text('candidates', P.CANDIDATAS, 'falas', { max: 6000, json: true })).toBe('{"tarefas": []}')
    expect(calls.map(call => call.body?.max_tokens)).toEqual([12000, 24000])
    expect(calls.every(call => !('response_format' in (call.body ?? {})))).toBe(true)
  })

  it('when the AI never writes the answer, the error says why: the limit spent thinking, or an empty reply', async () => {
    const eaten = () => sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'hmm' }, finish_reason: 'length' }] })}\n\n`, 'data: [DONE]\n\n'])
    installFetch(eaten)
    await expect(appAi(settings(), undefined, { text: 1000, vision: 1000, backoffMs: 1 }).text('candidates', P.CANDIDATAS, 'falas', { max: 100, json: true })).rejects.toThrow('A IA gastou o limite de 800 tokens pensando e não escreveu a resposta.')
    installFetch(() => openAiStream(''))
    await expect(appAi(settings(), undefined, { text: 1000, vision: 1000, backoffMs: 1 }).text('write', 'Escreva', 'falas')).rejects.toThrow('A IA respondeu vazio ou sem JSON legível.')
  })

  it('retries on 5xx and on timeout, gives up on 4xx, and stops at once when cancelled', async () => {
    const { AiError } = await import('@/controllers/ai.controller')
    let tries = 0
    expect(await withRetry(async () => (++tries < 2 ? Promise.reject(new AiError('A IA recusou o pedido (502): x')) : 'ok'), { timeoutMs: 1000, backoffMs: 1 })).toBe('ok')
    tries = 0
    expect(await withRetry(own => (++tries < 2 ? new Promise((_, reject) => own.addEventListener('abort', () => reject(new Cancelled()))) : Promise.resolve('ok')), { timeoutMs: 20, backoffMs: 1 })).toBe('ok')
    tries = 0
    await expect(withRetry(async () => (tries++, Promise.reject(new AiError('A IA recusou o pedido (401): chave'))), { timeoutMs: 1000, backoffMs: 1 })).rejects.toThrow('401')
    expect(tries).toBe(1)
    const parent = new AbortController()
    const waiting = withRetry(own => new Promise((_, reject) => own.addEventListener('abort', () => reject(new Cancelled()))), { signal: parent.signal, timeoutMs: 10000 })
    parent.abort()
    await expect(waiting).rejects.toBeInstanceOf(Cancelled)
  })
})

function memoryRepository() {
  const sidecars = new Map<string, FileSidecar>()
  const contents = new Map<string, string>()
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: async (id: string) => contents.get(id) ?? '',
    readSidecar: async (id: string) => sidecars.get(id)!,
    saveFile: async (sidecar: FileSidecar, content?: string) => {
      sidecars.set(sidecar.meta.id, sidecar)
      if (content !== undefined) contents.set(sidecar.meta.id, content)
      return sidecar
    },
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
  } as unknown as Repository
  return { repo, sidecars, contents }
}

describe('generating the Ata from a note', () => {
  let memory: ReturnType<typeof memoryRepository>
  const named = { ...meeting, speakers: [{ id: 'mic', name: 'Regy Niles', suggested: false }, { id: 'speaker_0', name: 'Henrique Souza', suggested: false }, { id: 'speaker_1', name: 'Natália Lenza', suggested: false }] }

  beforeEach(() => {
    memory = memoryRepository()
    const index = defaultIndex()
    index.settings.ai = { provider: 'custom', baseUrl: 'https://ia.exemplo.dev/v1', apiKey: 'k', model: 'geral' }
    useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
    useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
    useUiStore.setState({ menu: null, overlay: null })
  })

  async function note(transcribed = true): Promise<string> {
    const meta = await useLibraryStore.getState().createFile({ name: 'Reunião 28-10-2026, 18-15-41', type: 'reading', status: 'ready', folderId: null, origin: { input: 'recording', name: 'Reunião 28-10-2026, 18-15-41.webm', mime: 'audio/webm', durationSeconds: 320, storage: 'none' } }, transcribed ? 'Regy Niles [00:10]: Boa tarde' : '')
    if (transcribed) await useLibraryStore.getState().updateSidecar(meta.id, sidecar => ({ ...sidecar, recording: named }))
    return meta.id
  }

  it('Gerar › "Ata" opens the checkboxes; Resumo comes checked; nothing checked disables Gerar; the Ata tab appears', async () => {
    const { calls } = installFetch(request => openAiStream(textAnswer(systemPromptOf(request), userContentOf(request))))
    const id = await note()
    useUiStore.getState().openMenu({ kind: 'file', id, x: 1, y: 1 })
    const menu = render(
      <MemoryRouter>
        <ItemMenu />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Ata' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'ata-parts', fileId: id })
    menu.unmount()
    render(<AtaPartsDialog fileId={id} />)
    const dialog = screen.getByRole('dialog', { name: 'Gerar a Ata' })
    const boxes = within(dialog).getAllByRole('checkbox')
    expect(boxes.map(box => (box.parentElement?.textContent ?? '') + ((box as HTMLInputElement).checked ? '*' : ''))).toEqual(['Resumo*', 'Levantamento de tarefas', 'Perguntas em aberto', 'Linha do tempo', '1:1'])
    fireEvent.click(within(dialog).getByLabelText('Resumo'))
    expect(within(dialog).getByRole('button', { name: 'Gerar' })).toBeDisabled()
    fireEvent.click(within(dialog).getByLabelText('Resumo'))
    fireEvent.click(within(dialog).getByLabelText('Levantamento de tarefas'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(memory.sidecars.get(id)?.documents?.length).toBe(1))
    const saved = memory.sidecars.get(id)!.documents![0]
    expect(saved).toMatchObject({ kind: 'ata', parts: ['resumo', 'tarefas'], images: [], models: { context: 'geral', write: 'geral' } })
    expect(saved.stages?.length).toBeGreaterThan(2)
    expect(saved.markdown).toContain('[▸ 00:30](#t=30)')
    expect(saved.markdown).not.toMatch(/Você|Falante \d/)
    expect(calls.some(call => systemPromptOf(call) === P.ENTENDER && userContentOf(call).includes('28/10/2026 (quarta), 18:15'))).toBe(true)
    expect(useJobsStore.getState().jobs[0]).toMatchObject({ status: 'done', message: 'Ata pronta: veja a aba Ata.' })
    render(
      <MemoryRouter>
        <DocumentBody fileId={id} />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getAllByRole('tab').map(tab => `${tab.textContent}${tab.getAttribute('aria-selected') === 'true' ? '*' : ''}`)).toEqual(['Transcrição', 'Ata*']))
    expect(screen.getByTestId('markdown')).toHaveTextContent('## Levantamento de tarefas')
  })

  it('without transcription the menu item asks to transcribe first', async () => {
    const id = await note(false)
    useUiStore.getState().openMenu({ kind: 'file', id, x: 1, y: 1 })
    render(
      <MemoryRouter>
        <ItemMenu />
      </MemoryRouter>,
    )
    const item = screen.getByRole('button', { name: /^Ata/ })
    expect(item).toBeDisabled()
    expect(item).toHaveTextContent('transcrever antes')
  })

  it('Cancelar in the job stops the Ata and saves nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))),
    )
    const id = await note()
    const running = useJobsStore.getState().generateAta(id, ['resumo'])
    await waitFor(() => expect(useJobsStore.getState().jobs[0]?.status).toBe('running'))
    useJobsStore.getState().cancel(useJobsStore.getState().jobs[0].id)
    await running
    expect(useJobsStore.getState().jobs[0]).toMatchObject({ status: 'cancelled', message: 'Cancelado por você.' })
    expect(memory.sidecars.get(id)?.documents).toBeUndefined()
  })
})

function ShadowAta({ markdown }: { markdown: string }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = host.current!.shadowRoot ?? host.current!.attachShadow({ mode: 'open' })
    root.innerHTML = markdown.replace(/<a id="(\w+)"><\/a>/g, '<span id="$1"></span>').replace(/\[([^\]]+)\]\((#[^)]+)\)/g, '<a href="$2">$1</a>')
  }, [markdown])
  return <div ref={host} data-testid="ata" />
}

describe('the Ata tab', () => {
  it('a minute link plays the media from that second; a list link jumps to the task', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined)
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    const media = { url: 'blob:reuniao', available: true, video: false, request: async () => undefined }
    render(<MeetingTabs recording={meeting} media={media} ata={<ShadowAta markdown={'- [Ajustar](#t1)\n<a id="t1"></a> texto [▸ 01:05](#t=65)'} />} onChooseParts={() => undefined} />)
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Transcrição', 'Ata'])
    expect(screen.getByRole('button', { name: 'Refazer a Ata' })).toBeInTheDocument()
    const root = screen.getByTestId('ata').shadowRoot!
    fireEvent.click(root.querySelector('a[href="#t=65"]')!)
    expect(document.querySelector('audio')!.currentTime).toBe(65)
    expect(play).toHaveBeenCalledTimes(1)
    fireEvent.click(root.querySelector('a[href="#t1"]')!)
    expect(scroll).toHaveBeenCalledTimes(1)
  })
})
