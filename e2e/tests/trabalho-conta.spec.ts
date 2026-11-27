import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { type APIRequestContext, expect, request, test } from '@playwright/test'

import { FakeDrive, useFakeGoogle } from '../fixtures/fake-google'

import * as ATA from '../../src/lib/generation/ata-prompts'
import { PROMPTS } from '../../src/lib/generation/prompts.data'

/**
 * Generating in the account, end to end (spec 007, história 2, SC-004, T076): a device asks the account for a generation and closes
 * (here: it only made the request; no tab of the person stays open). The Go service opens the system's Chromium on the job's page of
 * the production app, the page runs the app's own generation against a fake AI provider, and the result shows on another device.
 * Run: cd e2e && npx playwright test -c playwright.trabalho.config.ts
 */

const APP = `http://localhost:${process.env.E2E_APP_PORT}`
const API = `http://localhost:${process.env.E2E_API_PORT}`
const EMAIL = 'pessoa@teste.local'
const PASSWORD = 'senha-de-teste-123'
const TAGS = { etiquetas: ['biologia-celular', 'mitocondria'] }
const SAID = 'a mitocôndria produz energia para a célula'

/** The system prompts the fake AI did not know: the test of a generation that did not end says them. */
const unknown: string[] = []
/** How long the fake AI takes to answer (a generation that runs for a while, to use the app meanwhile). */
let aiDelay = 0

/**
 * What the fake AI answers to each step of the app's generations (SC-004), by the system prompt the app asks it with: the formats each
 * one reads (the same the unit tests answer with); anything else gets a short note in Markdown, and its prompt is kept in `unknown`.
 */
function answerFor(system: string): string {
  const json = (value: unknown) => JSON.stringify(value)
  if (system.startsWith(PROMPTS.TAGS_PROMPT)) return json(TAGS)
  if (system.startsWith('Você dá nome a um material de estudo')) return json({ nome: 'Mitocôndria' })
  if (system.startsWith(PROMPTS.CARDS_PROMPT))
    return json({ cartoes: [{ frente: 'O que a mitocôndria produz?', verso: 'Energia para a célula.' }, { frente: 'Onde fica a mitocôndria?', verso: 'No citoplasma da célula.' }] })
  if (system.startsWith(PROMPTS.MINDMAP_PROMPT))
    return json({ nome: 'Mitocôndria', forma: 'arvore', raiz: { texto: 'Mitocôndria', filhos: [{ texto: 'Produz energia', filhos: [] }, { texto: 'Fica no citoplasma', filhos: [] }] } })
  if (system.startsWith(PROMPTS.QUESTIONS_PREP_PROMPT.split('{limite}')[0])) return 'A mitocôndria produz energia para a célula e fica no citoplasma.'
  if (system.includes(PROMPTS.EXAM_JSON)) {
    // five alternatives, A to E, the right one in A (the app shuffles them)
    const question = (enunciado: string, certa: string, erradas: string[]) => ({
      tipo: 'unica',
      nivel: 'lembrar',
      enunciado,
      alternativas: Object.fromEntries([certa, ...erradas].map((alternative, index) => ['ABCDE'[index], alternative])),
      correta: 'A',
      resposta_certa: certa,
      explicacao: `Porque ${certa.toLowerCase()}.`,
      diagrama: null,
    })
    return json({
      questions: [
        question('O que a mitocôndria produz?', 'Energia para a célula', ['Proteínas do núcleo', 'Água do citoplasma', 'Luz para a célula', 'Sal mineral']),
        question('Onde fica a mitocôndria?', 'No citoplasma', ['No núcleo', 'Na membrana', 'Fora da célula', 'No sangue']),
        question('Para que serve a energia da mitocôndria?', 'Para a célula funcionar', ['Para a célula se dividir ao meio', 'Para formar o núcleo', 'Para nada', 'Para esfriar a célula']),
      ],
    })
  }
  if (system.startsWith(PROMPTS.TITLE_PROMPT) || system.startsWith(PROMPTS.POLISH_PROMPT)) return json({ titulo: 'Reunião sobre a mitocôndria' })
  // the Ata by subject: what was talked about, with the moment of each point, and the next steps
  if (system.startsWith(PROMPTS.MINUTES_EXTRACT_PROMPT))
    return json({
      assunto: 'Reunião sobre a mitocôndria',
      temas: [{ tema: 'A mitocôndria', pontos: [{ texto: 'A mitocôndria produz energia para a célula.', hora: '00:00', citacao: 'a mitocôndria, que produz energia' }] }],
      passos: [{ texto: 'Trazer um resumo da respiração celular', quem: 'Ana', quando: 'próxima semana' }],
    })
  if (system.startsWith(ATA.ABERTURA_MODELO))
    return '# Ata: Reunião sobre a mitocôndria\n\n## Assuntos\n\n- A mitocôndria produz energia para a célula. [▸ 00:05]\n\n## Próximos passos\n\n1. Revisar o material da aula.\n'
  // the writing agents (Aula, Explicação, Reunião) answer the elements of the note, which the app turns into Markdown
  const agent = [PROMPTS.LESSON_PROMPT, PROMPTS.EXPLANATION_PROMPT, PROMPTS.MEETING_PROMPT].find(prompt => system.includes(prompt))
  if (agent)
    return json({
      markdown: {
        elements: [
          { type: 'heading', level: 1, text: agent === PROMPTS.MEETING_PROMPT ? 'Ata: Reunião sobre a mitocôndria' : 'Mitocôndria' },
          { type: 'paragraph', text: 'A mitocôndria produz energia para a célula e fica no citoplasma.' },
        ],
        diagrams: [],
      },
    })
  unknown.push(system.slice(0, 160))
  return '# Mitocôndria\n\nA mitocôndria produz energia para a célula.\n'
}

/** The fake DeepInfra: what it was asked, and a streamed answer (the app reads chat/completions as server events). */
const asked: { path: string; body: Record<string, unknown> }[] = []
let provider: Server

function startProvider(): Promise<void> {
  provider = createServer((incoming, response) => {
    let raw = ''
    incoming.on('data', chunk => (raw += chunk))
    incoming.on('end', () => {
      const json = (incoming.headers['content-type'] ?? '').includes('json')
      asked.push({ path: incoming.url ?? '', body: raw && json ? (JSON.parse(raw) as Record<string, unknown>) : {} })
      if (incoming.headers.authorization !== 'Bearer chave-falsa-e2e') return void response.writeHead(401).end()
      // the transcription (spec 007, "Não está gerando transcrição"): the words with their times, the plain text, and the speakers
      if (incoming.url === '/v1/openai/audio/transcriptions') {
        const words = SAID.split(' ').map((word, index) => ({ word, start: index * 0.4, end: index * 0.4 + 0.35 }))
        return void response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(raw.includes('verbose_json') ? { text: SAID, words } : { text: SAID }))
      }
      if (incoming.url === '/v1/inference/nvidia/Nemotron-3-Diarization') return void response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ speaker_segments: [{ speaker: 'SPEAKER_00', start: 0, end: 5 }] }))
      if (incoming.url !== '/v1/openai/chat/completions') return void response.writeHead(404).end()
      const messages = (asked.at(-1)?.body.messages ?? []) as { role: string; content: unknown }[]
      const text = (content: unknown) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? '').join('') : '')
      const answer = answerFor(text(messages.find(message => message.role === 'system')?.content))
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 12 } })}\n\n`)
        response.end('data: [DONE]\n\n')
      }, aiDelay)
    })
  })
  return new Promise(resolve => provider.listen(Number(process.env.E2E_AI_PORT), resolve))
}

/** The administration's choice of AI (spec 006): the fake DeepInfra for every use of text. */
function chooseFakeAi(): void {
  const uses = {
    providers: [{ id: 'deepinfra', type: 'deepinfra', name: 'DeepInfra', key: '', base: '' }],
    models: [
      { uid: 'falso', pid: 'deepinfra', mid: 'falso/modelo-de-teste', name: 'Modelo falso' },
      { uid: 'ouvir', pid: 'deepinfra', mid: 'openai/whisper-large-v3', name: 'Whisper falso' },
    ],
    defaults: { estudo: 'falso', titulo: 'falso', aula: 'falso', ata: 'falso', transcricao: 'ouvir' },
    steps: {},
  }
  const db = new DatabaseSync(path.join(process.env.E2E_DIR!, 'estudo.db'))
  db.exec('PRAGMA busy_timeout = 5000')
  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('ai_uses', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(uses))
  db.close()
}

/** A device signed in to the test account: its own cookies. */
async function device(): Promise<APIRequestContext> {
  const context = await request.newContext({ baseURL: API, extraHTTPHeaders: { Origin: APP, 'X-Estudo': '1' } })
  const login = await context.post('/v1/auth/password/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(login.ok(), await login.text()).toBe(true)
  return context
}

test.beforeAll(async () => {
  await startProvider()
  chooseFakeAi()
})

test.afterAll(() => new Promise<void>(resolve => (provider ? provider.close(() => resolve()) : resolve())))

test('uma geração pedida à conta roda no servidor e chega a outro aparelho', async () => {
  const asking = await device()
  const map = (await (await asking.get('/v1/library/map')).json()) as { rows: { id: string; itemKind: string; name: string; noteType: string | null }[] }
  const note = map.rows.find(row => row.itemKind === 'file' && row.name.startsWith('Nota de estudo'))
  expect(note, JSON.stringify(map.rows.map(row => row.name))).toBeTruthy()

  const made = await asking.post('/v1/jobs', { data: { call: 'suggestTags', args: [note!.id], fileId: note!.id, title: `Etiquetas · ${note!.name}` } })
  expect(made.ok(), await made.text()).toBe(true)
  const job = (await made.json()) as { id: string }
  // the asking device goes away: nothing of the person stays open
  await asking.dispose()

  const other = await device()
  let last: Record<string, unknown> = {}
  await expect
    .poll(
      async () => {
        last = (await (await other.get(`/v1/jobs/${job.id}`)).json()) as Record<string, unknown>
        return last.state
      },
      { timeout: 180_000, intervals: [1000] },
    )
    .toMatch(/^(done|failed)$/)
  expect(last.state, `o trabalho falhou: ${last.error} (${last.errorCode})`).toBe('done')
  expect(asked.some(call => call.path === '/v1/openai/chat/completions')).toBe(true)

  // the result, on the other device: the suggested tags of the note
  const item = await (await other.get(`/v1/library/items/${note!.id}`)).text()
  expect(item).toContain('biologia-celular')
  expect(item).toContain('mitocondria')

  // the list of the account's jobs (Gerações) has it done
  const jobs = (await (await other.get('/v1/jobs')).json()) as { jobs: { id: string; state: string }[] }
  expect(jobs.jobs.find(entry => entry.id === job.id)?.state).toBe('done')
  await other.dispose()
})

// "Não está gerando transcrição" (24/11): a gravação salva no App pede a transcrição à conta; ela tem de rodar no servidor e deixar o
// texto na nota, ou falhar dizendo por quê (nunca "pronto" sem nada)
test('uma transcrição pedida à conta roda no servidor e deixa o texto na nota', async () => {
  const asking = await device()
  const map = (await (await asking.get('/v1/library/map')).json()) as { rows: { id: string; itemKind: string; name: string }[] }
  const media = map.rows.find(row => row.itemKind === 'file' && row.name.startsWith('Áudio curto'))
  expect(media, JSON.stringify(map.rows.map(row => row.name))).toBeTruthy()
  const made = await asking.post('/v1/jobs', { data: { call: 'transcribeNote', args: [media!.id, { $indefinido: true }, null], fileId: media!.id, title: `Transcrição · ${media!.name}` } })
  expect(made.ok(), await made.text()).toBe(true)
  const job = (await made.json()) as { id: string }
  await asking.dispose()

  const other = await device()
  let last: Record<string, unknown> = {}
  await expect
    .poll(
      async () => {
        last = (await (await other.get(`/v1/jobs/${job.id}`)).json()) as Record<string, unknown>
        return last.state
      },
      { timeout: 180_000, intervals: [1000] },
    )
    .toMatch(/^(done|failed)$/)
  expect(last.state, `o trabalho falhou: ${last.error} (${last.errorCode})`).toBe('done')
  expect(asked.some(call => call.path === '/v1/openai/audio/transcriptions')).toBe(true)
  // the transcription is a part of its own of the note
  const item = (await (await other.get(`/v1/library/items/${media!.id}`)).json()) as { parts: { transcript?: string } }
  expect(item.parts.transcript, JSON.stringify(item.parts)).toBeTruthy()
  const transcript = await (await other.get(`/v1/library/items/${media!.id}/parts/transcript`)).text()
  expect(transcript).toContain('mitocôndria produz energia')
  await other.dispose()
})

// ---------- SC-004: each kind of generation of a short meeting runs in the account and reaches another device ----------

const stamp = () => ({ at: new Date().toISOString(), deviceId: 'e2e', deviceName: 'Teste ponta a ponta' })
const newId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`

/** A note of the App written by a device, as the app writes it: its line on the map, and its parts. */
async function putNote(device: APIRequestContext, fields: { id: string; name: string; type: string; folderId?: string | null; meta?: Record<string, unknown>; recording?: boolean }) {
  const at = new Date().toISOString()
  const meta = {
    id: fields.id, name: fields.name, folderId: fields.folderId ?? null, type: fields.type, description: '', status: 'ready', position: 0, favorite: false, tags: [], parentFileId: null,
    sourceExcerpt: null, pendingExcerpt: null, origin: null, generation: null, created: stamp(), updated: stamp(), deletedAt: null, words: 40, readingMinutes: 1, mastery: null,
    lastReviewedAt: null, questionCount: 0, ...fields.meta,
  }
  const row = { itemKind: 'file', noteType: fields.type, name: fields.name, folderId: fields.folderId ?? null, parentFileId: null, place: 'app', recording: Boolean(fields.recording), position: 0, meta, driveRef: null, createdAt: at, updatedAt: at, trashedAt: null, trashedWith: null }
  const put = await device.put(`/v1/library/items/${fields.id}`, { data: { baseRev: 0, row } })
  expect(put.ok(), await put.text()).toBe(true)
}

async function putPart(device: APIRequestContext, id: string, part: string, content: string) {
  const put = await device.put(`/v1/library/items/${id}/parts/${part}`, { data: content, headers: { 'If-None-Match': '*', 'Content-Type': 'text/plain; charset=utf-8' } })
  expect(put.ok(), await put.text()).toBe(true)
}

/** A short meeting recorded by the app, with its transcript (two people, about a minute). */
async function shortMeeting(device: APIRequestContext): Promise<string> {
  const id = newId('reuniao')
  await putNote(device, { id, name: 'Reunião curta', type: 'audio', recording: true, meta: { origin: { input: 'recording', name: 'reuniao-curta.webm', mime: 'audio/webm', durationSeconds: 60, storage: 'none' }, kept: 'registro' } })
  const blocks = [
    { speaker: 's1', start: 0, end: 8, text: 'Hoje vamos revisar a mitocôndria, que produz energia para a célula.' },
    { speaker: 's2', start: 9, end: 20, text: 'Ela fica no citoplasma, e a energia sai em forma de ATP.' },
    { speaker: 's1', start: 21, end: 35, text: 'Combinado: na próxima semana cada um traz um resumo da respiração celular.' },
  ]
  const recording = { blocks, speakers: [{ id: 's1', name: 'Ana', suggested: false }, { id: 's2', name: 'Bruno', suggested: false }], marks: [] }
  await putPart(device, id, 'transcript', JSON.stringify({ recording, transcript: null }))
  return id
}

/** A text note of the App (an explanation of a class). */
async function textNote(device: APIRequestContext): Promise<string> {
  const id = newId('nota')
  // a name of its own: two notes of the same name in a folder are refused (spec 005, FR-021)
  await putNote(device, { id, name: `Aula de biologia ${id}`, type: 'explanation' })
  await putPart(device, id, 'text', '# Mitocôndria\n\nA mitocôndria produz energia para a célula. Fica no citoplasma e libera energia em forma de ATP na respiração celular.')
  return id
}

/** Asks the account for the call and leaves (no tab of the person stays open); another device follows it to the end. */
async function runInAccount(call: string, args: unknown[], fileId: string | null, title: string): Promise<{ other: APIRequestContext; job: Record<string, unknown> }> {
  const asking = await device()
  const made = await asking.post('/v1/jobs', { data: { call, args, fileId, title } })
  expect(made.ok(), await made.text()).toBe(true)
  const { id } = (await made.json()) as { id: string }
  await asking.dispose()
  const other = await device()
  let job: Record<string, unknown> = {}
  await expect
    .poll(
      async () => {
        job = (await (await other.get(`/v1/jobs/${id}`)).json()) as Record<string, unknown>
        return job.state
      },
      { timeout: 240_000, intervals: [1000] },
    )
    .toMatch(/^(done|failed)$/)
  expect(job.state, `o trabalho falhou: ${job.error} (${job.errorCode}); a IA falsa não reconheceu: ${JSON.stringify(unknown)}`).toBe('done')
  return { other, job }
}

type MapRow = { id: string; itemKind: string; name: string; noteType: string | null; folderId: string | null; parentFileId: string | null; meta: Record<string, unknown> }
const mapOf = async (device: APIRequestContext) => ((await (await device.get('/v1/library/map')).json()) as { rows: MapRow[] }).rows

test('a Ata de uma reunião curta roda na conta e chega a outro aparelho', async () => {
  const meeting = await shortMeeting(await device())
  const { other } = await runInAccount('generateFromNote', [meeting, 'meeting'], meeting, 'Ata · Reunião curta')
  const ata = (await mapOf(other)).find(row => row.parentFileId === meeting && row.noteType === 'meeting')
  expect(ata, 'a Ata nasceu da reunião').toBeTruthy()
  expect(ata!.meta.status).toBe('ready')
  const text = await (await other.get(`/v1/library/items/${ata!.id}/parts/text`)).text()
  expect(text, `a IA falsa não reconheceu: ${JSON.stringify(unknown)}`).toContain('mitocôndria')
  await other.dispose()
})

for (const [kind, label] of [
  ['mapa', 'o mapa mental'],
  ['cartoes', 'os cartões'],
] as const)
  test(`${label} de uma nota roda na conta e chega a outro aparelho`, async () => {
    const note = await textNote(await device())
    const { other } = await runInAccount('generateArtifact', [{ fileId: note, artifact: kind }], note, `Mapa ou cartões · Aula de biologia`)
    const row = (await mapOf(other)).find(item => item.id === note)!
    const artifacts = (row.meta.artifacts ?? []) as { kind: string; name: string }[]
    expect(artifacts.map(item => item.kind), JSON.stringify(row.meta)).toContain(kind)
    await other.dispose()
  })

test('a Prova de uma nota roda na conta e chega a outro aparelho', async () => {
  const note = await textNote(await device())
  const { other } = await runInAccount('createQuestions', [note], note, 'Prova · Aula de biologia')
  const row = (await mapOf(other)).find(item => item.id === note)!
  expect(Number(row.meta.questionCount), JSON.stringify(row.meta)).toBeGreaterThan(0)
  await other.dispose()
})

test('as aulas de um curso rodam na conta e chegam a outro aparelho', async () => {
  const writer = await device()
  const folder = newId('curso')
  const at = new Date().toISOString()
  const folderMeta = { id: folder, name: 'Curso de biologia', parentId: null, position: 0, description: '', isCourse: true, courseOrigin: 'reuniao-curta.webm', courseDescription: 'A célula e a energia', courseMaterial: null, created: stamp(), updated: stamp(), deletedAt: null }
  const put = await writer.put(`/v1/library/items/${folder}`, { data: { baseRev: 0, row: { itemKind: 'folder', noteType: null, name: 'Curso de biologia', folderId: null, parentFileId: null, place: 'app', recording: false, position: 0, meta: folderMeta, driveRef: null, createdAt: at, updatedAt: at, trashedAt: null, trashedWith: null } } })
  expect(put.ok(), await put.text()).toBe(true)
  const lessons = [newId('aula'), newId('aula')]
  for (const [index, id] of lessons.entries())
    await putNote(writer, { id, name: `Aula ${index + 1}: ${index ? 'Respiração celular' : 'Mitocôndria'}`, type: 'class', folderId: folder, meta: { status: 'pending', description: index ? 'a respiração celular' : 'o que a mitocôndria faz', pendingExcerpt: 'A mitocôndria produz energia para a célula na respiração celular.', position: index } })
  await writer.dispose()
  const { other } = await runInAccount('generateRemaining', [folder], null, 'Aulas do curso')
  const rows = await mapOf(other)
  for (const id of lessons) {
    const lesson = rows.find(row => row.id === id)!
    expect(lesson.meta.status, `${lesson.name}: ${JSON.stringify(lesson.meta)}`).toBe('ready')
    expect(await (await other.get(`/v1/library/items/${id}/parts/text`)).text()).toContain('mitocôndria')
  }
  await other.dispose()
})

// SC-004, the other half: while a generation runs in the account, the app answers each tap at once (the device does not generate)
test('enquanto a Ata roda na conta, o app responde a cada clique em até 0,1 s', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await useFakeGoogle(context, new FakeDrive(), API)
  const login = await context.request.post(`${API}/v1/auth/password/login`, { data: { email: EMAIL, password: PASSWORD }, headers: { Origin: APP, 'X-Estudo': '1' } })
  expect(login.ok(), await login.text()).toBe(true)
  const page = await context.newPage()
  await page.addLocatorHandler(page.getByRole('dialog', { name: 'Quanto o app pode usar do seu Drive?' }), dialog => dialog.getByRole('button', { name: 'Salvar' }).click())
  await page.goto(`${APP}/biblioteca/seed-folder-001`)
  const row = page.getByRole('main').getByRole('row', { name: 'Nota de estudo 0002' })
  await expect(row).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.blk-layer')).toHaveCount(0)

  // the Ata of a short meeting goes to the account, with an AI that takes 3 s at each step
  const writer = await device()
  const meeting = await shortMeeting(writer)
  aiDelay = 3000
  try {
    const made = await writer.post('/v1/jobs', { data: { call: 'generateFromNote', args: [meeting, 'meeting'], fileId: meeting, title: 'Ata · Reunião curta' } })
    expect(made.ok(), await made.text()).toBe(true)
    const { id } = (await made.json()) as { id: string }
    const state = async () => ((await (await writer.get(`/v1/jobs/${id}`)).json()) as { state: string }).state
    await expect.poll(state, { timeout: 120_000, intervals: [200] }).toBe('running')

    // favorite and back, six times: from the click to the frame with the star changed
    const times: number[] = []
    for (let turn = 0; turn < 6; turn++) {
      const star = row.locator('button.star')
      times.push(
        await star.evaluate(async button => {
          const was = button.classList.contains('on')
          const start = performance.now()
          ;(button as HTMLElement).click()
          while (button.classList.contains('on') === was && performance.now() - start < 2000) await new Promise(resolve => requestAnimationFrame(resolve))
          return performance.now() - start
        }),
      )
    }
    // the clicks were made with the Ata still being written in the account
    expect(await state()).toBe('running')
    console.log(`cliques durante a Ata na conta: ${times.map(ms => Math.round(ms)).join(', ')} ms`)
    expect(Math.max(...times), `cliques: ${times.map(ms => Math.round(ms)).join(', ')} ms`).toBeLessThanOrEqual(100)
  } finally {
    aiDelay = 0
    await writer.dispose()
    await context.close()
  }
})
