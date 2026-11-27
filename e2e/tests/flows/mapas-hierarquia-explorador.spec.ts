import { test as base, expect, type BrowserContext, type Locator, type Page, type Request, type Route } from '@playwright/test'

/**
 * Feature 002 (specs/002-mapas-hierarquia-explorador): one browser flow per story.
 * Each flow runs in its own empty browser profile, seeds through the app's stores and talks to a fake AI answered here.
 * Nothing leaves localhost: see `guardNetwork`, whose count is asserted at the end of every flow.
 */

const FAKE_AI = 'https://api.exemplo.dev/v1'
const MODEL_UID = 'falso::modelo-teste'
const MODEL_ID = 'modelo-teste'
/** index.html links these; they are aborted, and anything else aborted fails the flow. */
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com'])
const CORS = { 'access-control-allow-origin': '*' }
const INSTRUCTION_HEAD = '## Instrução de quem pediu'

const SYSTEM = {
  map: 'Você faz o mapa de uma nota',
  mapChat: 'Você conversa com a pessoa sobre um mapa mental',
  lesson: 'Você é o Agente Aula',
  tags: 'Você sugere etiquetas',
  /** The system prompt of the diagnosis tests that expect JSON (the title test is one). */
  diagnosisJson: 'Responda somente em JSON, em português do Brasil.',
}
/** DeepInfra's public list: answered here, empty, so a second provider can be registered without a model to test. */
const DEEPINFRA_LIST = 'https://api.deepinfra.com/models/list'

/* ---------- The network: the fake AI, and the count of what tried to leave ---------- */

interface ChatCall {
  system: string
  user: string
}

interface Net {
  chats: ChatCall[]
  faked: string[]
  aborted: string[]
  /** Every http(s) request to outside localhost that the browser reported. */
  observed: Request[]
  /** Those that went through the guard (answered or aborted). */
  handled: Set<Request>
  sockets: string[]
  /** System prompts the fake does not know: an AI call nobody expected in this flow. */
  unknown: string[]
  pageErrors: string[]
  /** What the fake answers to a diagnosis test, set by the flow that runs one. */
  diagnosisReply: string
  /** While set, diagnosis tests wait for it: the flow sees the diagnosis running before it ends. */
  hold: Promise<void> | null
}

const isOutside = (url: URL) => /^(https?|wss?):$/.test(url.protocol) && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1'

function sse(text: string): string {
  const size = Math.max(1, Math.ceil(text.length / 3))
  const events: string[] = []
  for (let start = 0; start < text.length; start += size) events.push(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(start, start + size) } }] })}\n\n`)
  events.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\n`, 'data: [DONE]\n\n')
  return events.join('')
}

const MAPS = {
  general: { nome: 'Panorama do contrato', forma: 'radial', raiz: { texto: 'Contrato de aluguel', filhos: [{ texto: 'Partes' }, { texto: 'Valores' }, { texto: 'Prazos' }] } },
  decisions: {
    nome: 'Decisões do contrato',
    forma: 'arvore',
    raiz: {
      texto: 'Decisões',
      filhos: [
        { texto: 'Reajuste anual', filhos: [{ texto: 'Pelo IPCA' }] },
        { texto: 'Multa por atraso', filhos: [{ texto: 'Dois por cento' }] },
        { texto: 'Fiador dispensado' },
      ],
    },
  },
  deadlines: {
    nome: 'Prazos do contrato',
    forma: 'linha-do-tempo',
    raiz: {
      texto: 'Prazos',
      filhos: [
        { texto: 'Março', filhos: [{ texto: 'Assinatura' }] },
        { texto: 'Abril', filhos: [{ texto: 'Vistoria' }] },
        { texto: 'Dezembro', filhos: [{ texto: 'Reajuste' }] },
      ],
    },
  },
}

const INSTRUCTION = { decisions: 'foque nas decisões', deadlines: 'monte a linha do tempo dos prazos' }
const MERGED_BRANCH = 'Reajuste e multa'

function mapAnswer(user: string) {
  const asked = user.includes(INSTRUCTION_HEAD) ? user.slice(user.indexOf(INSTRUCTION_HEAD)) : ''
  if (asked.includes(INSTRUCTION.decisions)) return MAPS.decisions
  if (asked.includes(INSTRUCTION.deadlines)) return MAPS.deadlines
  return MAPS.general
}

/** Joins the first two branches of the tree the app sent, keeping the ids it gave, as the prompt asks. */
function mapChatAnswer(user: string) {
  const tree = JSON.parse(/Mapa atual:\n(\{.*\})\n\nConversa/s.exec(user)![1]) as { filhos: { filhos: unknown[] }[] }
  const [first, second, ...rest] = tree.filhos
  return {
    resposta: `Pronto, juntei os dois ramos em “${MERGED_BRANCH}”.`,
    mapa: { ...tree, filhos: [{ id: 'novo1', texto: MERGED_BRANCH, filhos: [...first.filhos, ...second.filhos] }, ...rest] },
  }
}

function aiAnswer(call: ChatCall, net: Net): string {
  if (call.system.includes(SYSTEM.map)) return JSON.stringify(mapAnswer(call.user))
  if (call.system.includes(SYSTEM.mapChat)) return JSON.stringify(mapChatAnswer(call.user))
  if (call.system.includes(SYSTEM.lesson)) return JSON.stringify({ markdown: { elements: [{ type: 'heading', level: 1, text: 'Aula gerada no teste' }, { type: 'paragraph', text: 'Posse e propriedade, em poucas linhas.' }], diagrams: [] } })
  if (call.system.includes(SYSTEM.tags)) return JSON.stringify({ etiquetas: ['direito'] })
  if (call.system === SYSTEM.diagnosisJson) return net.diagnosisReply
  net.unknown.push(call.system.slice(0, 120))
  return '{}'
}

async function answerFake(route: Route, net: Net): Promise<void> {
  const request = route.request()
  net.faked.push(`${request.method()} ${request.url()}`)
  if (request.url().endsWith('/models')) return route.fulfill({ headers: CORS, json: { data: [{ id: MODEL_ID }] } })
  if (request.url() === DEEPINFRA_LIST) return route.fulfill({ headers: CORS, json: [] })
  const body = request.postDataJSON() as { messages: { role: string; content: string }[] }
  const call = { system: body.messages.find(message => message.role === 'system')?.content ?? '', user: body.messages.find(message => message.role === 'user')?.content ?? '' }
  net.chats.push(call)
  if (call.system === SYSTEM.diagnosisJson && net.hold) await net.hold
  return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: sse(aiAnswer(call, net)) })
}

/** Everything outside localhost is answered by the fake or aborted. The Vite HMR socket is held here too, so an edit elsewhere in the repo cannot reload a flow halfway. */
async function guardNetwork(context: BrowserContext): Promise<Net> {
  const net: Net = { chats: [], faked: [], aborted: [], observed: [], handled: new Set(), sockets: [], unknown: [], pageErrors: [], diagnosisReply: '{}', hold: null }
  context.on('request', request => {
    if (isOutside(new URL(request.url()))) net.observed.push(request)
  })
  await context.route(isOutside, async route => {
    net.handled.add(route.request())
    if (route.request().url().startsWith(FAKE_AI) || route.request().url() === DEEPINFRA_LIST) return answerFake(route, net)
    net.aborted.push(route.request().url())
    await route.abort('blockedbyclient')
  })
  await context.routeWebSocket(/^wss?:\/\//, socket => {
    if (!isOutside(new URL(socket.url()))) return
    net.sockets.push(socket.url())
    void socket.close()
  })
  return net
}

const test = base.extend<{ net: Net }>({
  net: async ({ context, page }, use, testInfo) => {
    const net = await guardNetwork(context)
    page.on('pageerror', error => net.pageErrors.push(error.message))
    // A dynamic import inside page.evaluate would be rewritten for Node by the test transpiler, so it lives in a plain string.
    // It imports the URL the app itself loaded: after an edit Vite serves `?t=…`, and a bare path would be a second, empty store.
    await page.addInitScript(`
      performance.setResourceTimingBufferSize(20000);
      window.__app = async path => {
        const url = performance.getEntriesByType('resource').map(entry => entry.name).filter(name => new URL(name).pathname === path).pop();
        if (!url) throw new Error('module not loaded yet: ' + path);
        return import(url);
      };
    `)
    await use(net)
    const leaks = net.observed.filter(request => !net.handled.has(request)).map(request => request.url())
    const unexpected = net.aborted.filter(url => !FONT_HOSTS.has(new URL(url).hostname))
    console.log(`  [net] ${testInfo.title}: outside localhost ${net.observed.length} = fake answered ${net.faked.length} (${net.chats.length} AI calls) + aborted ${net.aborted.length} (unexpected ${unexpected.length}); sockets out ${net.sockets.length}; leaks ${leaks.length}`)
    expect(leaks, 'requests that left localhost without passing the guard').toEqual([])
    expect(unexpected, 'requests to outside localhost that the flow did not expect').toEqual([])
    expect(net.sockets, 'WebSockets to outside localhost').toEqual([])
    expect(net.unknown, 'AI calls with a prompt this flow did not expect').toEqual([])
    expect(net.pageErrors, 'uncaught errors in the page').toEqual([])
  },
})

/* ---------- Seeding through the app's own stores ---------- */

declare global {
  interface Window {
    __app(path: string): Promise<any>
  }
}

const LIBRARY = '/src/stores/library.ts'

interface FileRow {
  id: string
  name: string
  role?: string
  folderId: string | null
  parentFileId: string | null
  deletedAt: string | null
  trashedWith?: string
  status: string
  artifacts?: { id: string; kind: string; name: string }[]
}

interface FolderRow {
  id: string
  name: string
  parentId: string | null
}

async function appReady(page: Page): Promise<void> {
  await expect(async () => {
    const ready = await page.evaluate(async path => (await window.__app(path)).useLibraryStore.getState().ready as boolean, LIBRARY)
    expect(ready).toBe(true)
  }).toPass({ timeout: 45_000 })
}

/** Opens the app and connects it to the fake AI. */
async function start(page: Page): Promise<void> {
  await page.goto('/biblioteca')
  await appReady(page)
  await page.evaluate(
    async ([path, base, uid, mid]) => {
      const { useLibraryStore } = await window.__app(path)
      await useLibraryStore.getState().updateSettings({
        aiConfig: {
          providers: [{ id: 'falso', type: 'custom', name: 'Provedor de teste', key: 'chave-falsa', base }],
          models: [{ uid, pid: 'falso', mid, name: 'Modelo de teste' }],
          defaults: { estudo: uid },
          steps: {},
        },
      })
    },
    [LIBRARY, FAKE_AI, MODEL_UID, MODEL_ID],
  )
}

async function reopen(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await appReady(page)
}

type FileFields = Record<string, unknown> & { name: string; type: string }

async function createFile(page: Page, fields: FileFields, content: string): Promise<string> {
  return page.evaluate(async ([path, fields, content]) => (await (await window.__app(path as string)).useLibraryStore.getState().createFile(fields, content)).id as string, [LIBRARY, fields, content] as const)
}

async function createFolder(page: Page, fields: Record<string, unknown> & { name: string }): Promise<string> {
  return page.evaluate(async ([path, fields]) => (await (await window.__app(path as string)).useLibraryStore.getState().createFolder(fields)).id as string, [LIBRARY, fields] as const)
}

async function files(page: Page): Promise<FileRow[]> {
  return page.evaluate(async path => (await window.__app(path)).useLibraryStore.getState().files as FileRow[], LIBRARY)
}

async function folders(page: Page): Promise<FolderRow[]> {
  return page.evaluate(async path => (await window.__app(path)).useLibraryStore.getState().folders as FolderRow[], LIBRARY)
}

async function mapsOf(page: Page, fileId: string): Promise<{ id: string; name: string; versions: unknown[]; chat: unknown[]; made?: { instruction?: string }; diagram: { form: string; root: unknown } }[]> {
  return page.evaluate(
    async ([path, id]) => {
      const opened = await (await window.__app(path)).useLibraryStore.getState().openFile(id)
      return opened.sidecar.artifacts.filter((item: { kind: string }) => item.kind === 'mapa')
    },
    [LIBRARY, fileId],
  )
}

const fileNamed = async (page: Page, name: string) => (await files(page)).filter(file => file.name === name)
const folderNamed = async (page: Page, name: string) => (await folders(page)).find(folder => folder.name === name)

/* ---------- The screens ---------- */

const rowMenu = async (page: Page, name: string): Promise<Locator> => {
  await page.getByRole('button', { name: `Opções de ${name}`, exact: true }).first().click()
  return page.getByRole('menu', { name: `Opções de ${name}`, exact: true })
}

const mapDialog = (page: Page, name: string | RegExp = /^Mapa mental: /) => page.getByRole('dialog', { name: typeof name === 'string' ? `Mapa mental: ${name}` : name })
const mapOutline = (page: Page) => page.getByRole('list', { name: 'Itens do mapa' })
const instructionField = (scope: Locator) => scope.getByLabel('Instrução extra para a IA (opcional)')

/** The diagram Mermaid drew: its kind says which form the map got. */
const expectForm = async (dialog: Locator, kind: RegExp) => expect(dialog.locator('svg[aria-roledescription]')).toHaveAttribute('aria-roledescription', kind)

const FORM = { radial: /^mindmap$/, tree: /^flowchart/, timeline: /^timeline$/ }

/**
 * The generate window opens the new map when it is ready. If it stays open instead, that fails the flow (soft, so the rest of the
 * story still runs and reports): the map is then opened from the note's list.
 */
async function generatedMap(page: Page, generating: Locator, name: string): Promise<Locator> {
  const dialog = mapDialog(page, name)
  const heading = dialog.getByRole('heading', { name })
  const toast = page.locator('.toast', { hasText: `“${name}” ficou pronto` })
  await heading.or(toast).first().waitFor({ timeout: 30_000 })
  const toasted = await toast.isVisible()
  expect.soft(await heading.isVisible(), `the generate window should open “${name}” when it is ready${toasted ? '; it stayed open and only a toast said so, as if it had been closed' : ''}`).toBe(true)
  if (await heading.isVisible()) return dialog
  const listed = page.getByRole('complementary', { name: 'Painel do documento' }).getByRole('region', { name: 'Mapas mentais' }).getByRole('button', { name, exact: true })
  await expect(listed).toBeVisible()
  await generating.getByRole('button', { name: 'Cancelar' }).click()
  await listed.click()
  await expect(heading).toBeVisible()
  return dialog
}

interface FolderStep {
  filter: string
  found: string
  /** The folder the found one lives in, shown in the result row. */
  foundIn: string
  create: string
  destination: string
}

/** Inside a folder chooser: filter by part of the name, mark the result, create a subfolder in place. */
async function filterAndCreate(chooser: Locator, step: FolderStep): Promise<void> {
  await chooser.getByRole('searchbox', { name: 'Filtrar pastas' }).fill(step.filter)
  const results = chooser.getByRole('tree', { name: 'Pastas encontradas' })
  await expect(results.getByRole('treeitem')).toHaveCount(1)
  const found = results.getByRole('treeitem', { name: step.found })
  await expect(found).toContainText(step.foundIn)
  await found.click()
  await expect(found).toHaveAttribute('aria-selected', 'true')
  await chooser.getByRole('textbox', { name: 'Nome da pasta nova' }).fill(step.create)
  await chooser.getByRole('button', { name: 'Criar', exact: true }).click()
  // back in the tree, with the new folder marked and visible
  await expect(chooser.getByRole('tree', { name: 'Todas as pastas' }).getByRole('treeitem', { name: step.create })).toHaveAttribute('aria-selected', 'true')
  await expect(chooser.getByRole('group', { name: 'Fica em' })).toContainText(step.destination)
}

/* ---------- US1: maps ---------- */

const CONTRACT = 'Contrato de aluguel'
const CONTRACT_TEXT = ['# Contrato de aluguel', 'O reajuste é anual pelo IPCA. A multa por atraso é de dois por cento.', 'A assinatura foi em março, a vistoria em abril e o reajuste vem em dezembro.'].join('\n\n')

test('US1: dois mapas da mesma nota com instruções diferentes, chat que muda e desfaz', async ({ page, net }) => {
  await start(page)
  const noteId = await createFile(page, { name: CONTRACT, type: 'reading' }, CONTRACT_TEXT)

  // The first map of a note.
  await (await rowMenu(page, CONTRACT)).locator('.mi', { hasText: 'Mapa mental' }).click()
  const first = page.getByRole('dialog', { name: `Mapa mental: ${CONTRACT}` })
  await expect(first.getByLabel('Modelo da IA')).toHaveValue(MODEL_UID)
  await first.getByRole('button', { name: 'Fazer o mapa mental' }).click()
  const general = mapDialog(page, MAPS.general.nome)
  await expect(general.getByRole('heading', { name: MAPS.general.nome })).toBeVisible()
  await expectForm(general, FORM.radial)
  await general.getByRole('button', { name: 'Fechar' }).click()

  // A second one with an instruction, from "Desta nota".
  await page.goto(`/arquivo/${noteId}`)
  await appReady(page)
  const panel = page.getByRole('complementary', { name: 'Painel do documento' })
  await expect(panel.getByRole('tab', { name: 'Desta nota' })).toHaveAttribute('aria-selected', 'true')
  await panel.getByRole('button', { name: 'Novo mapa mental' }).click()
  const fresh = page.getByRole('dialog', { name: 'Novo mapa mental' })
  await expect(fresh.getByLabel('Modelo da IA')).toHaveValue(MODEL_UID)
  await fresh.getByText('Mais opções').click()
  await instructionField(fresh).fill(INSTRUCTION.decisions)
  await fresh.getByRole('button', { name: 'Gerar', exact: true }).click()
  const decisions = await generatedMap(page, fresh, MAPS.decisions.nome)
  await expectForm(decisions, FORM.tree)
  await expect(mapOutline(page)).toContainText('Multa por atraso')

  // "Gerar de novo": model and instruction of the last time, "Criar outro" marked.
  await decisions.getByRole('button', { name: 'Gerar de novo…' }).click()
  const again = page.getByRole('dialog', { name: 'Gerar de novo o mapa' })
  await expect(again.getByLabel('Modelo da IA')).toHaveValue(MODEL_UID)
  await expect(instructionField(again)).toHaveValue(INSTRUCTION.decisions)
  await expect(again.getByRole('radio', { name: /Criar outro mapa/ })).toHaveAttribute('aria-checked', 'true')
  await instructionField(again).fill(INSTRUCTION.deadlines)
  await again.getByRole('button', { name: 'Gerar', exact: true }).click()
  const deadlines = await generatedMap(page, again, MAPS.deadlines.nome)
  await expectForm(deadlines, FORM.timeline)
  await deadlines.getByRole('button', { name: 'Fechar' }).click()

  // Each instruction reached the AI, and the first map went without one.
  const asked = net.chats.filter(call => call.system.includes(SYSTEM.map)).map(call => call.user)
  expect(asked).toHaveLength(3)
  expect(asked.every(user => user.includes('O reajuste é anual'))).toBe(true)
  expect(asked[0]).not.toContain(INSTRUCTION_HEAD)
  expect(asked[1]).toContain(INSTRUCTION.decisions)
  expect(asked[2]).toContain(INSTRUCTION.deadlines)

  // All three by name in "Desta nota", each with its own form.
  const list = panel.getByRole('region', { name: 'Mapas mentais' })
  await expect(list.getByRole('heading', { name: 'Mapas mentais · 3' })).toBeVisible()
  for (const name of [MAPS.general.nome, MAPS.decisions.nome, MAPS.deadlines.nome]) await expect(list.getByRole('button', { name, exact: true })).toBeVisible()
  const saved = await mapsOf(page, noteId)
  expect(Object.fromEntries(saved.map(map => [map.name, map.diagram.form]))).toEqual({ [MAPS.general.nome]: 'radial', [MAPS.decisions.nome]: 'arvore', [MAPS.deadlines.nome]: 'linha-do-tempo' })
  expect(saved.find(map => map.name === MAPS.deadlines.nome)?.made?.instruction).toBe(INSTRUCTION.deadlines)

  // In the map chat, a change: the map changes at once and the touched branches blink.
  await list.getByRole('button', { name: MAPS.decisions.nome, exact: true }).click()
  const open = mapDialog(page, MAPS.decisions.nome)
  await expectForm(open, FORM.tree)
  const before = await mapOutline(page).innerText()
  const undoButton = open.getByRole('button', { name: 'Desfazer', exact: true })
  await expect(undoButton).toBeDisabled()
  await open.getByLabel('Pergunte ou peça uma mudança').fill('junte os dois primeiros ramos')
  await open.getByRole('button', { name: 'Enviar' }).click()
  const talk = open.getByRole('list', { name: 'Conversa do mapa' })
  await expect(talk).toContainText('junte os dois primeiros ramos')
  await expect(talk).toContainText(`juntei os dois ramos em “${MERGED_BRANCH}”`)
  await expect(talk).toContainText(/Mudei \d+ ramos?/)
  await expect(mapOutline(page)).toContainText(MERGED_BRANCH)
  await expect(mapOutline(page)).not.toContainText('Multa por atraso')
  await expect(mapOutline(page).locator('.pisca')).not.toHaveCount(0)
  await expect(open.locator('svg[aria-roledescription]')).toContainText(MERGED_BRANCH)
  await expect(undoButton).toBeEnabled()
  const chatCall = net.chats.find(call => call.system.includes(SYSTEM.mapChat))
  expect(chatCall?.user).toContain('Pedido agora: junte os dois primeiros ramos')
  expect(chatCall?.user).toContain('O reajuste é anual')

  // "Desfazer" brings back exactly what was there; the conversation stays.
  await undoButton.click()
  await expect(mapOutline(page)).toContainText('Multa por atraso')
  await expect(mapOutline(page)).not.toContainText(MERGED_BRANCH)
  expect(await mapOutline(page).innerText()).toBe(before)
  await expect(mapOutline(page).locator('.pisca')).toHaveCount(0)
  await expect(undoButton).toBeDisabled()
  await expect(open.getByRole('button', { name: 'Desfazer esta mudança' })).toHaveCount(0)
  await expect(talk).toContainText(`juntei os dois ramos em “${MERGED_BRANCH}”`)
  await open.getByRole('button', { name: 'Fechar' }).click()
  const undone = (await mapsOf(page, noteId)).find(map => map.name === MAPS.decisions.nome)!
  expect(undone.versions).toHaveLength(0)
  expect(undone.chat).toHaveLength(2)

  // It all survives a reload.
  await reopen(page, `/arquivo/${noteId}`)
  const reloaded = page.getByRole('complementary', { name: 'Painel do documento' }).getByRole('region', { name: 'Mapas mentais' })
  await expect(reloaded.getByRole('heading', { name: 'Mapas mentais · 3' })).toBeVisible()
  await expect(reloaded.getByRole('button', { name: 'Conversa do mapa · 2 mensagens' })).toBeVisible()
})

/* ---------- US2: entrada, notes and what comes back from the Lixeira ---------- */

const SOURCE = 'Apostila de contratos'
const SOURCE_TEXT = 'Contrato é o acordo de vontades. Elementos: partes, objeto e forma.'
const LESSON = 'Aula: Apostila de contratos'
const EXPLANATION = 'Explicação: Apostila de contratos'
const CHILD = 'Aula: Elementos do contrato'
const FAMILY_COUNT = '3 notas · 1 artefato'
const ALL_FOUR = [SOURCE, LESSON, EXPLANATION, CHILD]

test('US2: entrada com duas notas e uma filha; árvore, contagem, Gerar desta entrada, Apagar tudo e restaurar', async ({ page, net }) => {
  await start(page)
  const law = await createFolder(page, { name: 'Direito' })
  const notes = await createFolder(page, { name: 'Anotações' })
  const entry = await createFile(page, { name: SOURCE, type: 'reading', role: 'entrada', kept: 'registro', folderId: law, origin: { input: 'text', name: SOURCE, mime: 'text/plain', storage: 'none', sizeBytes: SOURCE_TEXT.length } }, SOURCE_TEXT)
  const lesson = await createFile(page, { name: LESSON, type: 'class', folderId: law, parentFileId: entry }, '# Aula\n\nPartes, objeto e forma.')
  await createFile(page, { name: EXPLANATION, type: 'explanation', folderId: notes, parentFileId: entry }, '# Explicação\n\nO acordo de vontades.')
  const child = await createFile(page, { name: CHILD, type: 'class', folderId: law, parentFileId: lesson }, '# Elementos\n\nDetalhe das partes.')
  await page.evaluate(
    async ([library, artifacts, fileId]) => {
      const { newMapArtifact } = await window.__app(artifacts)
      const map = newMapArtifact({ name: 'Mapa dos elementos', diagram: { form: 'radial', root: { id: 'r', text: 'Elementos', children: [{ id: 'a', text: 'Partes', children: [] }] } } })
      await (await window.__app(library)).useLibraryStore.getState().saveArtifact(fileId, map)
    },
    [LIBRARY, '/src/lib/artifacts.ts', child],
  )

  // The count in the Entradas list.
  await page.getByRole('navigation').getByRole('button', { name: /^Entradas/ }).first().click()
  const table = page.getByRole('table', { name: 'Entradas' })
  const row = table.getByRole('row', { name: new RegExp(SOURCE) })
  await expect(row).toContainText(FAMILY_COUNT)
  await expect(row).toContainText('Texto colado')

  // The entrada's page: the original, the tree with the count.
  await row.getByRole('link', { name: SOURCE }).click()
  await expect(page).toHaveURL(new RegExp(`/entrada/${entry}$`))
  await expect(page.getByRole('heading', { level: 1, name: SOURCE })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Original' })).toBeVisible()
  const family = page.getByRole('region', { name: 'O que nasceu daqui' })
  await expect(family).toContainText(FAMILY_COUNT)
  for (const name of [LESSON, EXPLANATION, CHILD]) await expect(family.getByRole('link', { name, exact: true })).toBeVisible()
  await expect(family.locator('li', { has: page.getByRole('link', { name: LESSON, exact: true }) }).locator('ul').getByRole('link', { name: CHILD, exact: true })).toBeVisible()
  await expect(family.getByRole('link', { name: 'Mapa dos elementos' })).toBeVisible()

  // "Gerar desta entrada" opens, offering what can be made and where it goes.
  await page.getByRole('button', { name: 'Gerar desta entrada' }).click()
  const generate = page.getByRole('dialog', { name: 'Gerar desta entrada' })
  await expect(generate).toContainText(SOURCE)
  for (const goal of ['Ata', 'Aula', 'Explicação']) await expect(generate.getByRole('radiogroup', { name: 'O que gerar' }).getByRole('radio', { name: new RegExp(goal) })).toBeVisible()
  await expect(generate.getByLabel('Modelo da IA')).toHaveValue(MODEL_UID)
  await expect(generate.getByRole('group', { name: 'Salvar em' })).toContainText('Direito')
  await expect(generate.getByRole('button', { name: 'Gerar', exact: true })).toBeEnabled()
  await generate.getByRole('button', { name: 'Cancelar' }).click()
  await expect(generate).toHaveCount(0)
  expect(net.chats, 'nothing was generated in this flow').toHaveLength(0)

  // Deleting shows the whole tree and sends all of it to the Lixeira.
  await page.getByRole('button', { name: 'Mais ações' }).click()
  await page.getByRole('menu', { name: 'Ações da entrada' }).getByRole('menuitem', { name: 'Apagar…' }).click()
  const confirm = page.getByRole('alertdialog', { name: `Apagar “${SOURCE}”?` })
  await expect(confirm).toContainText(FAMILY_COUNT)
  const tree = confirm.getByRole('list', { name: 'O que vai junto' })
  for (const name of [LESSON, EXPLANATION, CHILD]) await expect(tree).toContainText(name)
  await expect(confirm.getByRole('button', { name: 'Apagar só esta' })).toBeVisible()
  await confirm.getByRole('button', { name: 'Apagar tudo' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'foram para a Lixeira' })).toBeVisible()
  await expect(page).not.toHaveURL(/\/entrada\//)
  const trashed = await files(page)
  expect(trashed.every(file => file.deletedAt && file.trashedWith === entry)).toBe(true)

  // Gone from the Entradas list, all four in the Lixeira, marked to come back together.
  await page.getByRole('navigation').getByRole('button', { name: /^Entradas/ }).first().click()
  await expect(page.getByText('Nenhuma entrada ainda')).toBeVisible()
  await page.getByRole('button', { name: /^Lixeira/ }).first().click()
  for (const name of ALL_FOUR) await expect(page.locator('.title').getByText(name, { exact: true })).toBeVisible()
  await expect(page.getByText('volta junto com mais 3 itens')).toHaveCount(4)

  // Restoring one brings back the whole family, with the same links and folders.
  await page.locator('.row', { has: page.locator('.title', { hasText: new RegExp(`^${SOURCE}$`) }) }).getByRole('button', { name: 'Restaurar' }).click()
  await expect(page.getByRole('status').filter({ hasText: '4 itens restaurados' })).toBeVisible()
  await expect(page.getByText('A lixeira está vazia.')).toBeVisible()
  const back = await files(page)
  expect(back).toHaveLength(4)
  expect(back.every(file => file.deletedAt === null && !file.trashedWith)).toBe(true)
  expect(back.find(file => file.name === CHILD)?.parentFileId).toBe(lesson)
  expect(back.find(file => file.name === EXPLANATION)?.folderId).toBe(notes)

  await page.getByRole('navigation').getByRole('button', { name: /^Entradas/ }).first().click()
  await expect(table.getByRole('row', { name: new RegExp(SOURCE) })).toContainText(FAMILY_COUNT)
  await reopen(page, `/entrada/${entry}`)
  const restored = page.getByRole('region', { name: 'O que nasceu daqui' })
  await expect(restored).toContainText(FAMILY_COUNT)
  for (const name of [LESSON, EXPLANATION, CHILD]) await expect(restored.getByRole('link', { name, exact: true })).toBeVisible()
})

/* ---------- US3: one folder chooser wherever a folder is asked for ---------- */

const MOVED = 'Resumo de obrigações'
const REAL_RIGHTS = 'Direito das coisas'
const REAL_RIGHTS_LESSON = `Aula: ${REAL_RIGHTS}`

test('US3: Mover para…, Salvar em › Trocar e Gerar de novo; filtra, cria subpasta e confere onde foi parar', async ({ page, net }) => {
  await start(page)
  const law = await createFolder(page, { name: 'Direito' })
  await createFolder(page, { name: 'Civil', parentId: law })
  await createFolder(page, { name: 'Penal', parentId: law })
  await createFolder(page, { name: 'Matemática' })
  await createFolder(page, { name: 'Provas', favorite: true, color: 'verde' })
  await createFile(page, { name: MOVED, type: 'reading' }, '# Obrigações\n\nDar, fazer e não fazer.')
  await createFile(page, { name: REAL_RIGHTS, type: 'reading' }, '# Direito das coisas\n\nPosse e propriedade.')

  // "Mover para…": the favorites on top, the default marked, then filter and create in place.
  await (await rowMenu(page, MOVED)).locator('.mi', { hasText: /^Mover/ }).click()
  const move = page.getByRole('dialog', { name: 'Mover 1 item' })
  await expect(move.getByRole('list', { name: 'Favoritas' })).toContainText('Provas')
  await expect(move.getByRole('tree', { name: 'Todas as pastas' }).getByRole('treeitem', { name: 'Biblioteca (raiz)' })).toHaveAttribute('aria-selected', 'true')
  await filterAndCreate(move, { filter: 'civ', found: 'Civil', foundIn: 'Direito', create: 'Contratos 2026', destination: 'Direito › Civil › Contratos 2026' })
  await move.getByRole('button', { name: 'Mover', exact: true }).click()
  await expect(move).toHaveCount(0)

  const contracts = await folderNamed(page, 'Contratos 2026')
  expect(contracts?.parentId).toBe((await folderNamed(page, 'Civil'))?.id)
  expect((await fileNamed(page, MOVED))[0].folderId).toBe(contracts?.id)
  await expect(page.locator(`[data-file-id]`, { hasText: MOVED })).toHaveCount(0)
  await reopen(page, `/biblioteca/${contracts?.id}`)
  await expect(page.locator(`[data-file-id]`, { hasText: MOVED })).toBeVisible()

  // A generate window: "Salvar em › Trocar", filter, create, and the note lands there.
  await page.goto('/biblioteca')
  await appReady(page)
  await (await rowMenu(page, REAL_RIGHTS)).locator('.mi', { hasText: 'Aula' }).click()
  const generate = page.getByRole('dialog', { name: 'Gerar a Aula' })
  const saveIn = generate.getByRole('group', { name: 'Salvar em' })
  await expect(saveIn).toContainText(`${REAL_RIGHTS} (pasta nova)`)
  await saveIn.getByRole('button', { name: 'Trocar' }).click()
  const chooser = page.getByRole('dialog', { name: 'Onde salvar a nota nova' })
  await filterAndCreate(chooser, { filter: 'pena', found: 'Penal', foundIn: 'Direito', create: 'Aulas geradas', destination: `Direito › Penal › Aulas geradas › ${REAL_RIGHTS_LESSON}` })
  await chooser.getByRole('button', { name: 'Usar esta pasta' }).click()
  await expect(chooser).toHaveCount(0)
  await expect(saveIn).toContainText('Direito › Penal › Aulas geradas')
  await generate.getByRole('button', { name: 'Gerar', exact: true }).click()

  const generated = await folderNamed(page, 'Aulas geradas')
  expect(generated?.parentId).toBe((await folderNamed(page, 'Penal'))?.id)
  await expect.poll(async () => (await fileNamed(page, REAL_RIGHTS_LESSON))[0]?.status).toBe('ready')
  const lesson = (await fileNamed(page, REAL_RIGHTS_LESSON))[0]
  expect(lesson.folderId).toBe(generated?.id)
  expect((await fileNamed(page, REAL_RIGHTS))[0].folderId, 'only the new note goes to the chosen folder').toBeNull()
  await expect(page.getByRole('heading', { name: 'Aula gerada no teste' })).toBeVisible()
  await reopen(page, `/biblioteca/${generated?.id}`)
  const generatedRow = page.locator('[data-file-id]', { hasText: REAL_RIGHTS_LESSON })
  await expect(generatedRow).toBeVisible()

  // "Gerar de novo" of that note, as a new note: the chooser comes up at once.
  await (await rowMenu(page, REAL_RIGHTS_LESSON)).locator('.mi', { hasText: 'Gerar de novo' }).click()
  const again = page.getByRole('dialog', { name: 'Gerar de novo a Aula' })
  await again.getByRole('radio', { name: /Criar nota nova/ }).click()
  const secondChooser = page.getByRole('dialog', { name: 'Onde salvar a nota nova' })
  await filterAndCreate(secondChooser, { filter: 'matem', found: 'Matemática', foundIn: 'Biblioteca', create: 'Refeitas', destination: `Matemática › Refeitas › ${REAL_RIGHTS_LESSON}` })
  await secondChooser.getByRole('button', { name: 'Usar esta pasta' }).click()
  await expect(again.getByRole('group', { name: 'Salvar em' })).toContainText('Matemática › Refeitas')
  await again.getByRole('button', { name: 'Gerar', exact: true }).click()

  const remade = await folderNamed(page, 'Refeitas')
  await expect.poll(async () => (await fileNamed(page, REAL_RIGHTS_LESSON)).length).toBe(2)
  await expect.poll(async () => (await fileNamed(page, REAL_RIGHTS_LESSON)).every(file => file.status === 'ready')).toBe(true)
  const both = await fileNamed(page, REAL_RIGHTS_LESSON)
  expect(both.map(file => file.folderId).sort()).toEqual([generated?.id, remade?.id].sort())
  await reopen(page, `/biblioteca/${remade?.id}`)
  await expect(page.locator('[data-file-id]', { hasText: REAL_RIGHTS_LESSON })).toBeVisible()
  expect(net.chats.filter(call => call.system.includes(SYSTEM.lesson))).toHaveLength(2)
})

/* ---------- US4: the main table ---------- */

const stamp = (at: string) => ({ at, deviceId: 'local', deviceName: 'Este computador' })

const LIMITS = 'Limites laterais e continuidade'
const DERIVATIVES = 'Derivadas pela definição'
const TUTORING = 'Monitoria de limites'
const CHAIN = 'Regra da cadeia'
const CALCULUS_NOTES = [LIMITS, DERIVATIVES, TUTORING, CHAIN]
/** [name, created, updated]: the order by name, by Criado and by Atualizado are all different. */
const DATED: [string, string, string][] = [
  [LIMITS, '2026-10-01T15:00:00Z', '2026-10-20T16:30:00Z'],
  [DERIVATIVES, '2026-10-05T15:00:00Z', '2026-10-06T15:00:00Z'],
  [TUTORING, '2026-09-15T15:00:00Z', '2026-10-30T15:00:00Z'],
  [CHAIN, '2026-10-10T15:00:00Z', '2026-10-12T15:00:00Z'],
]
const VIDEO_OCTOBER = 'Aula gravada de derivadas'
const VIDEO_OCTOBER_NO_MEETING = 'Aula gravada de integrais'
const VIDEO_SEPTEMBER = 'Aula gravada de limites'
const MEETING_NOTE = `Ata: ${VIDEO_OCTOBER}`

const mainTable = (page: Page) => page.getByRole('table', { name: 'Notas e pastas' })
const fileRows = (page: Page) => mainTable(page).locator('tr[data-file-id]')
const namesOnTable = (page: Page) => fileRows(page).evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')))
const sideBar = (page: Page) => page.getByRole('complementary', { name: 'Navegação' })
const sortBy = async (page: Page, column: 'Criado' | 'Atualizado') => {
  const header = mainTable(page).getByRole('columnheader', { name: new RegExp(`^${column}`) })
  await header.getByRole('button', { name: new RegExp(`^${column}`) }).click()
  return header
}

test('US4: marca três notas e arrasta para a pasta; favorita e colore; ordena por data; combina filtros', async ({ page, net }) => {
  await start(page)
  const calculus = await createFolder(page, { name: 'Cálculo I' })
  await createFolder(page, { name: 'Física II' })
  for (const [name, created, updated] of DATED) await createFile(page, { name, type: 'reading', folderId: calculus, created: stamp(created), updated: stamp(updated) }, `# ${name}\n\nTexto de ${name}.`)
  const video = (name: string, at: string): FileFields => ({ name, type: 'reading', role: 'entrada', kept: 'registro', created: stamp(at), updated: stamp(at), origin: { input: 'file', name: `${name}.mp4`, mime: 'video/mp4', storage: 'none', sizeBytes: 1000 } })
  const october = await createFile(page, video(VIDEO_OCTOBER, '2026-10-12T15:00:00Z'), '')
  await createFile(page, video(VIDEO_OCTOBER_NO_MEETING, '2026-10-20T15:00:00Z'), '')
  await createFile(page, video(VIDEO_SEPTEMBER, '2026-09-02T15:00:00Z'), '')
  await createFile(page, { name: 'Stewart, capítulo 2', type: 'reading', role: 'entrada', kept: 'registro', created: stamp('2026-10-14T15:00:00Z'), updated: stamp('2026-10-14T15:00:00Z'), origin: { input: 'file', name: 'stewart.pdf', mime: 'application/pdf', storage: 'none', sizeBytes: 1000 } }, '')
  await createFile(page, { name: MEETING_NOTE, type: 'meeting', parentFileId: october, created: stamp('2026-10-12T16:00:00Z'), updated: stamp('2026-10-12T16:00:00Z') }, '# Ata\n\nDecisões.')
  await reopen(page, `/biblioteca/${calculus}`)

  // The table has the dates, and a click on the column orders by it: newest first, then the reverse.
  await expect(mainTable(page).getByRole('columnheader', { name: /^Criado/ })).toBeVisible()
  await expect(mainTable(page).getByRole('columnheader', { name: /^Atualizado/ })).toBeVisible()
  const byCreated = await sortBy(page, 'Criado')
  await expect(byCreated).toHaveAttribute('aria-sort', 'descending')
  expect(await namesOnTable(page)).toEqual([CHAIN, DERIVATIVES, LIMITS, TUTORING])
  await sortBy(page, 'Criado')
  await expect(byCreated).toHaveAttribute('aria-sort', 'ascending')
  expect(await namesOnTable(page)).toEqual([TUTORING, LIMITS, DERIVATIVES, CHAIN])
  const byUpdated = await sortBy(page, 'Atualizado')
  await expect(byUpdated).toHaveAttribute('aria-sort', 'descending')
  await expect(byCreated).not.toHaveAttribute('aria-sort', /ascending|descending/)
  expect(await namesOnTable(page)).toEqual([TUTORING, LIMITS, CHAIN, DERIVATIVES])

  // Three marked notes, the bar acts on all of them, and one drag takes them to the folder.
  for (const name of [LIMITS, DERIVATIVES, TUTORING]) await mainTable(page).getByRole('checkbox', { name: `Marcar ${name}` }).click()
  const bar = page.getByRole('toolbar', { name: 'Seleção' })
  await expect(bar).toContainText('3 selecionados')
  await expect(bar.getByRole('button', { name: 'Mover para…' })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'Apagar' })).toBeVisible()
  const destination = sideBar(page).getByRole('tree', { name: 'Pastas' }).getByRole('treeitem', { name: 'Física II' })
  await fileRows(page).filter({ hasText: DERIVATIVES }).dragTo(destination)
  await expect.poll(async () => (await files(page)).filter(file => CALCULUS_NOTES.includes(file.name) && file.folderId !== calculus).length).toBe(3)
  const physics = (await folderNamed(page, 'Física II'))!
  const moved = (await files(page)).filter(file => file.folderId === physics.id).map(file => file.name)
  expect(moved.sort()).toEqual([DERIVATIVES, LIMITS, TUTORING].sort())
  expect((await fileNamed(page, CHAIN))[0].folderId, 'the note that was not marked stays').toBe(calculus)
  expect(await namesOnTable(page)).toEqual([CHAIN])
  await expect(bar).toHaveCount(0)

  // The folder: favorite and one of the 7 colors, seen everywhere the folder shows.
  await reopen(page, '/biblioteca')
  await (await rowMenu(page, 'Física II')).getByRole('button', { name: 'Favoritar' }).click()
  const favorites = sideBar(page).getByRole('list', { name: 'Favoritos' })
  await expect(favorites.getByRole('listitem').filter({ hasText: 'Física II' })).toHaveCount(1)
  await (await rowMenu(page, 'Física II')).getByRole('group', { name: 'Cor da pasta' }).getByRole('button', { name: 'Azul' }).click()
  await expect(favorites.getByRole('img', { name: 'Pasta azul' })).toBeVisible()
  await expect(sideBar(page).getByRole('tree', { name: 'Pastas' }).getByRole('treeitem', { name: 'Física II' }).getByRole('img', { name: 'Pasta azul' })).toBeVisible()
  await expect(mainTable(page).getByRole('row', { name: /Física II/ }).getByRole('img', { name: 'Pasta azul' })).toBeVisible()
  await expect(mainTable(page).getByRole('row', { name: /Cálculo I/ }).getByRole('img')).toHaveCount(0)
  expect(await folderNamed(page, 'Física II')).toMatchObject({ favorite: true, color: 'azul' })
  await reopen(page, '/biblioteca')
  await expect(sideBar(page).getByRole('list', { name: 'Favoritos' }).getByRole('img', { name: 'Pasta azul' })).toBeVisible()

  // Combined filters on the library: video, created in October, generated an Ata.
  const panel = page.getByRole('complementary', { name: 'Filtros' })
  const active = page.getByRole('group', { name: 'Filtros ativos' })
  await expect(active).toHaveCount(0)
  await panel.getByRole('checkbox', { name: /^Vídeo\b/ }).click()
  await expect(active).toContainText(/Tipo\s*vídeo/)
  expect((await namesOnTable(page)).sort()).toEqual([VIDEO_OCTOBER, VIDEO_OCTOBER_NO_MEETING, VIDEO_SEPTEMBER].sort())
  await panel.getByRole('radiogroup', { name: 'Data do período' }).getByText('Criado', { exact: true }).click()
  await panel.getByRole('radio', { name: /^Escolher datas/ }).click()
  await panel.getByLabel('De', { exact: true }).fill('2026-10-01')
  await panel.getByLabel('Até', { exact: true }).fill('2026-10-31')
  await expect(active).toContainText(/Criado\s*01\/10\/2026 a 31\/10\/2026/)
  expect((await namesOnTable(page)).sort()).toEqual([VIDEO_OCTOBER, VIDEO_OCTOBER_NO_MEETING].sort())
  await panel.getByRole('checkbox', { name: /^Ata\b/ }).click()
  await expect(active).toContainText(/Tipo\s*vídeo/)
  await expect(active).toContainText(/O que gerou\s*ata/)
  expect(await namesOnTable(page)).toEqual([VIDEO_OCTOBER])
  await page.getByRole('button', { name: 'Limpar tudo' }).click()
  await expect(active).toHaveCount(0)
  expect(await namesOnTable(page)).toContain(VIDEO_SEPTEMBER)
  expect(net.chats, 'the table needs no AI').toHaveLength(0)
})

/* ---------- US5: model recommendations ---------- */

const REQUIREMENTS = '/src/lib/ai/use-requirements.ts'

/** Opens Configurações › Inteligência artificial › Recomendações. */
async function openRecommendations(page: Page): Promise<Locator> {
  await sideBar(page).getByRole('button', { name: 'Configurações' }).click()
  const settings = page.getByRole('dialog', { name: 'Configurações' })
  await settings.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name: 'Inteligência artificial' }).click()
  await settings.getByRole('tab', { name: 'Recomendações' }).click()
  return settings
}

const costOf = (text: string | null) => Number(/US\$\s*([\d.]+,\d+)/.exec(text ?? '')?.[1].replace('.', '').replace(',', '.'))

test('US5: a lista fixa por uso, a escada do mais barato para cima, um par como padrão e o diagnóstico com IA falsa', async ({ page, net }) => {
  await start(page)
  // A second registered provider (DeepInfra, whose list is answered empty here), so a pair of the list can become a default.
  await page.evaluate(
    async ([path, base, uid, mid]) => {
      const { useLibraryStore } = await window.__app(path)
      await useLibraryStore.getState().updateSettings({
        aiConfig: {
          providers: [
            { id: 'falso', type: 'custom', name: 'Provedor de teste', key: 'chave-falsa', base },
            { id: 'di', type: 'deepinfra', name: 'DeepInfra', key: 'chave-falsa', base: '' },
          ],
          models: [{ uid, pid: 'falso', mid, name: 'Modelo de teste' }],
          defaults: { estudo: uid },
          steps: {},
        },
      })
    },
    [LIBRARY, FAKE_AI, MODEL_UID, MODEL_ID],
  )
  const settings = await openRecommendations(page)
  await expect(settings.getByRole('tab', { name: 'Recomendações' })).toHaveAttribute('aria-selected', 'true')

  // "Geral": the date of the fixed list, and one row per use with the indicated, the cost per note and what is in use today.
  await expect(settings.getByText(/07\/11\/2026/).first()).toBeVisible()
  const overview = settings.getByRole('table', { name: 'Todos os usos' })
  const rows = overview.getByRole('row')
  expect(await rows.count()).toBeGreaterThan(8)
  const estudo = overview.getByRole('row', { name: /^Estudo\b/ })
  await expect(estudo).toContainText('Modelo de teste')
  await expect(estudo).toContainText(/nota \d/)
  expect(costOf(await estudo.textContent())).toBeGreaterThan(0)
  await expect(overview.getByRole('row', { name: /^Aula\b/ })).toContainText('herda')
  await expect(settings.getByText(/\d+ iguais · \d+ diferem/)).toBeVisible()

  // The ladder of one use: what it asks for, the minimum grade, the indicated one first and the cost never going down.
  await overview.getByRole('row', { name: /^Ata\b/ }).getByRole('button', { name: 'Ata', exact: true }).click()
  const ladder = settings.getByRole('region', { name: 'Escada de Ata' })
  await expect(ladder).toContainText(/mínima \d/)
  const pairs = ladder.getByRole('table', { name: 'Pares de Ata' })
  const rungs = pairs.getByRole('row')
  const listed = await rungs.evaluateAll(list => list.slice(1).map(row => row.textContent ?? ''))
  // Under "fora da escada" come the pairs that do not reach the minimum grade or were not tested: they are not on the ladder.
  const cut = listed.findIndex(text => text.includes('fora da escada'))
  const names = cut < 0 ? listed : listed.slice(0, cut)
  expect(names.length).toBeGreaterThan(2)
  const indicated = /Indicado:\s*(.+?)(?:\n|$|·)/.exec((await ladder.textContent()) ?? '')
  expect(indicated, 'the ladder says which one is indicated').not.toBeNull()
  const costs = names.map(costOf)
  expect(costs.every(Number.isFinite), `every rung has a cost: ${names.join(' | ')}`).toBe(true)
  expect(costs, 'the ladder goes from the cheapest up').toEqual([...costs].sort((a, b) => a - b))
  expect(names[0]).toContain(indicated![1].split(' · ')[0].trim())

  // "Usar como padrão" on a pair of the registered provider writes the default of that use only.
  const use = pairs.getByRole('button', { name: /como padrão$/, disabled: false }).first()
  const picked = ((await use.getAttribute('aria-label')) ?? (await use.textContent()) ?? '').trim()
  await use.click()
  const config = await page.evaluate(async path => (await window.__app(path)).useLibraryStore.getState().index.settings.aiConfig as { defaults: Record<string, string> }, LIBRARY)
  expect(config.defaults.ata, picked).toMatch(/^di::/)
  expect(config.defaults.estudo, 'the other defaults stay').toBe(MODEL_UID)
  await expect(pairs.getByRole('row').filter({ hasText: 'padrão atual' })).toHaveCount(1)
  await expect(pairs.getByRole('row').filter({ hasText: 'padrão atual' })).toContainText('DeepInfra')

  // The diagnosis of one use, with the fake: the cost comes first, then it runs (and can be stopped), then the result with its date.
  await ladder.getByRole('button', { name: 'Geral · todos os usos' }).click()
  await overview.getByRole('row', { name: /^Título/ }).getByRole('button', { name: /^Título/ }).click()
  const hits = await page.evaluate(async ([path]) => ((await window.__app(path)).USE_REQUIREMENTS.titulo.test.expected as { accept: string[] }[]).map(item => item.accept[0]), [REQUIREMENTS])
  net.diagnosisReply = JSON.stringify({ titulo: hits[0], etiquetas: hits.slice(1, 4) })
  let release!: () => void
  net.hold = new Promise<void>(resolve => (release = resolve))
  expect(net.chats, 'nothing is asked before the person agrees').toHaveLength(0)
  await settings.getByRole('button', { name: 'Rodar meu diagnóstico' }).click()
  const plan = settings.getByRole('group', { name: 'Diagnóstico antes de rodar' })
  await expect(plan).toContainText(/Custo estimado: US\$ [\d?]/)
  expect(net.chats, 'the cost is shown before anything is spent').toHaveLength(0)
  await plan.getByRole('button', { name: /^Rodar · ~US\$/ }).click()
  const running = settings.getByRole('status', { name: 'Diagnóstico rodando' })
  await expect(running).toContainText(/Rodando/)
  await expect(running.getByRole('button', { name: 'Parar' })).toBeVisible()
  release()
  const done = settings.getByRole('group', { name: 'Resultado do diagnóstico' })
  await expect(done).toContainText(/\d{2}\/\d{2}\/\d{4}/)
  await expect(done).toContainText(/guardado por modelo e provedor/)
  const records = await page.evaluate(async path => (await window.__app(path)).useLibraryStore.getState().index.settings.aiDiagnosis as { use: string; model: string; score: number | null; at: string }[], LIBRARY)
  expect(records.find(record => record.use === 'titulo' && record.model === MODEL_ID)).toMatchObject({ score: 10 })
  expect(net.chats.length).toBeGreaterThan(0)
  expect(net.chats.every(call => call.system === SYSTEM.diagnosisJson)).toBe(true)
  await expect(settings.getByRole('region', { name: 'Escada de Título' }).getByRole('row').filter({ hasText: MODEL_ID })).toContainText(/10 · \d{2}\/\d{2}/)
})
