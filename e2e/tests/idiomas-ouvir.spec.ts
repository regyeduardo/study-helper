import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { type BrowserContext, expect, type Page, test } from '@playwright/test'

import { FakeDrive, useFakeGoogle } from '../fixtures/fake-google'

/**
 * Spec 004, entrega 1 (dono, 23/11: "somente ouvindo (as frases), sem falar"), in real Chromium: turn the structure on, make English,
 * send a text, wait for it to be generated (fake AI provider: the cards of api/internal/langs/testdata/ok.json), study it from the
 * Vocabulário (25/11: no "Frases" part; the parts can be switched), with the model voice through the server in the listening cards,
 * see the end and study an area with all the texts (FR-044). Run: cd e2e && npx playwright test -c playwright.idiomas.config.ts
 */

const APP = `http://localhost:${process.env.E2E_APP_PORT}`
const API = `http://localhost:${process.env.E2E_API_PORT}`
const PASSWORD = 'senha-de-teste-123'
const EMAIL = 'pessoa@teste.local'
const SHOTS = process.env.E2E_SHOTS ?? path.join(process.env.E2E_DIR!, 'shots')
let CODE = ''
const LYRIC = ['I used to walk to school every day', "But now I won't walk in the rain"]

const CARDS = readFileSync(path.resolve(__dirname, '../../api/internal/langs/testdata/ok.json'), 'utf8')
// the card made again after "Reportar" (another way: other sentences)
const REMADE = JSON.stringify({
  test: [
    { type: 'listen_mc', skill: 'listen', q: 'Ouça e escolha o sentido (refeito):', say: 'We walk home after class', opts: ['andamos para casa', 'corremos para casa', 'voltamos de carro', 'ficamos em casa', 'andamos pela casa'], a: 0 },
    { type: 'mc', skill: 'read', q: '"walk" quer dizer (refeito):', opts: ['correr', 'andar', 'saltar', 'parar', 'nadar'], a: 1 },
  ],
})
const VOICE = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6:sample_rate=24000', '-f', 'mp3', 'pipe:1'])

/** The fake provider: what it was asked, and the answers of DeepInfra's OpenAI-like API. */
const asked: { path: string; body: Record<string, unknown> }[] = []
let provider: Server

function startProvider(): Promise<void> {
  provider = createServer((request, response) => {
    let raw = ''
    request.on('data', chunk => (raw += chunk))
    request.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      asked.push({ path: request.url ?? '', body })
      if (request.headers.authorization !== 'Bearer chave-falsa-e2e') {
        response.writeHead(401).end()
        return
      }
      if (request.url === '/v1/openai/chat/completions') {
        const prompt = String((body.messages as { content: string }[])[0].content)
        const content = prompt.includes('reported this card') ? REMADE : CARDS
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content } }] }))
        return
      }
      if (request.url === '/v1/openai/audio/speech') {
        response.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end(VOICE)
        return
      }
      response.writeHead(404).end()
    })
  })
  return new Promise(resolve => provider.listen(Number(process.env.E2E_AI_PORT), resolve))
}

function createCode(): void {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
  CODE = `E2E${run}`
  const db = new DatabaseSync(path.join(process.env.E2E_DIR!, 'estudo.db'))
  const now = new Date()
  db.prepare(`INSERT INTO promo_codes (id, code, max_uses, uses, valid_until, made_for, created_at) VALUES (?, ?, 1, 0, ?, 'teste de ponta a ponta', ?)`).run(
    `e2e-${run}`,
    CODE,
    new Date(now.getTime() + 86_400_000).toISOString(),
    now.toISOString(),
  )
  db.close()
}

async function openApp(page: Page): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await (attempt === 1 ? page.goto(APP) : page.reload())
    try {
      await expect(page.getByRole('button', { name: 'Configurações' }).first()).toBeVisible({ timeout: 30_000 })
      return
    } catch (error) {
      if (attempt === 3) throw error
    }
  }
}

async function turnOnStructure(page: Page) {
  await page.getByRole('button', { name: 'Configurações' }).first().click()
  const settings = page.getByRole('dialog', { name: 'Configurações' })
  await settings.getByRole('button', { name: 'Outros', exact: true }).click()
  await settings.getByRole('switch', { name: 'Usar a estrutura do app' }).click()
  const signIn = page.getByRole('dialog', { name: 'Entrar no Estudo' })
  await signIn.getByRole('button', { name: 'Não tem conta? Criar com e-mail e senha' }).click()
  await signIn.getByLabel('Nome').fill('Pessoa Teste')
  await signIn.getByLabel('E-mail').fill(EMAIL)
  await signIn.getByLabel('Senha', { exact: true }).fill(PASSWORD)
  await signIn.getByRole('button', { name: 'Criar conta', exact: true }).click()
  await expect
    .poll(async () => ((await (await page.request.get(`${API}/v1/me`)).json()) as { user?: { hierarchyAt?: string | null } }).user?.hierarchyAt ?? null, { timeout: 60_000 })
    .not.toBeNull()
  await expect(page.getByText('Levando a biblioteca para a sua conta')).toBeHidden({ timeout: 60_000 })
  const code = page.getByRole('dialog', { name: 'Usar a estrutura do app' })
  await code.getByLabel('Código').fill(CODE)
  await code.getByRole('button', { name: 'Liberar' }).click()
  await expect(settings.getByText('A estrutura do app está ligada nesta conta.')).toBeVisible()
  await settings.getByRole('button', { name: 'Fechar', exact: true }).click()
}

/** Answers the card shown, whatever its type (the order is drawn since 25/11). */
async function answerAny(page: Page) {
  const pieces = page.getByRole('group', { name: 'Peças' })
  const left = page.getByRole('group', { name: 'Esquerda' })
  if (await pieces.isVisible()) while ((await pieces.getByRole('button').count()) > 0) await pieces.getByRole('button').first().click()
  else if (await left.isVisible()) {
    const n = await left.getByRole('button').count()
    for (let i = 0; i < n; i++) {
      await left.getByRole('button').nth(i).click()
      await page.getByRole('group', { name: 'Direita' }).getByRole('button', { disabled: false }).first().click()
    }
  } else if ((await page.getByRole('textbox').count()) > 0) for (const field of await page.getByRole('textbox').all()) await field.fill('walk')
  else await page.getByRole('radio').first().click()
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true })
}

test.describe.serial('Idiomas, entrega 1: ouvir as frases e os cards de ouvir', () => {
  let context: BrowserContext
  let page: Page
  let languageUrl = ''
  // the model voice the app got from the server (the listening cards play it by themselves, 250 ms after opening)
  let voices = 0

  test.beforeAll(async ({ browser }) => {
    await startProvider()
    createCode()
    const drive = new FakeDrive()
    context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await useFakeGoogle(context, drive, API)
    page = await context.newPage()
    page.on('response', response => {
      if (response.url().endsWith('/v1/speech/tts') && response.request().method() === 'POST' && response.status() === 200 && response.headers()['content-type'] === 'audio/mpeg') voices++
    })
    await page.addLocatorHandler(page.getByRole('dialog', { name: 'Quanto o app pode usar do seu Drive?' }), dialog => dialog.getByRole('button', { name: 'Salvar' }).click())
    await openApp(page)
    await turnOnStructure(page)
  })

  test.afterAll(async () => {
    await context?.close()
    provider?.close()
  })

  test('1. Idiomas no menu; criar o Inglês', async () => {
    await page.getByRole('button', { name: 'Idiomas', exact: true }).click()
    await expect(page).toHaveURL(/\/idiomas$/)
    await expect(page.getByRole('heading', { name: 'Escolha o primeiro idioma' })).toBeVisible()
    await shot(page, '1-idiomas-vazio')
    await page.getByRole('button', { name: 'Novo idioma' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Novo idioma' })
    await dialog.getByLabel('Buscar idioma').fill('ingl')
    await dialog.getByRole('radio', { name: /Inglês/ }).click()
    await shot(page, '2-novo-idioma')
    await dialog.getByRole('button', { name: 'Criar' }).click()
    await expect(page.getByRole('heading', { name: 'Inglês' })).toBeVisible()
    languageUrl = page.url()
  })

  test('2. mandar o texto inteiro; gera sozinho e a página atualiza', async () => {
    await page.getByRole('button', { name: 'Novo texto' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Novo texto em Inglês' })
    await dialog.getByLabel('Título').fill('Caminhar na chuva')
    await dialog.getByLabel('Texto').fill(LYRIC.join('\n'))
    await shot(page, '3-novo-texto')
    await dialog.getByRole('button', { name: 'Mandar' }).click()
    await expect(dialog).toBeHidden()
    // the fake provider answers at once: the page asks again every 5 s and the text turns ready by itself
    await expect(page.getByRole('button', { name: /Começar/ })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('você já sabe 0%')).toBeVisible()
    const chat = asked.find(call => call.path === '/v1/openai/chat/completions')
    expect(String((chat?.body.messages as { content: string }[])[0].content)).toContain(LYRIC[1])
    await expect(page.getByRole('rowheader', { name: 'Gramática' })).toBeVisible()
    await shot(page, '4-pagina-do-idioma')
  })

  // 25/11 (FR-041, FR-043): no "Frases" part; the parts can be switched and each one keeps where it stopped
  test('3. o estudo abre no Vocabulário; as partes são clicáveis', async () => {
    await page.getByRole('button', { name: /Começar/ }).click()
    const parts = page.getByRole('list', { name: 'Partes do estudo' })
    await expect(parts.getByRole('button', { name: 'Vocabulário' })).toHaveAttribute('aria-current', 'step')
    await expect(page.getByRole('button', { name: 'Conferir' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Ouvir tudo/ })).toHaveCount(0)
    const first = await page.locator('.lg-q').textContent()
    await shot(page, '5-vocabulario')
    await parts.getByRole('button', { name: 'Prática' }).click()
    await expect(parts.getByRole('button', { name: 'Prática' })).toHaveAttribute('aria-current', 'step')
    await expect(page.locator('.lg-kicker').first()).toHaveText(/^Prática/)
    await shot(page, '5b-pratica')
    await parts.getByRole('button', { name: 'Vocabulário' }).click()
    await expect(page.locator('.lg-q')).toHaveText(first ?? '')
  })

  test('4. o estudo inteiro: Vocabulário, Prática de ler e ouvir, Contexto e o fim', async () => {
    test.setTimeout(180_000)
    await expect(page.getByRole('list', { name: 'Partes do estudo' })).toBeVisible()
    // the quiet flag reports the card; it is made again another way (the other model) and replaces the old one
    await page.getByRole('button', { name: 'Reportar este card' }).click()
    const report = page.getByRole('dialog', { name: 'Reportar este card' })
    await report.getByRole('radio', { name: 'Duas opções estão certas' }).click()
    await shot(page, '6b-reportar')
    await report.getByRole('button', { name: 'Refazer o card' }).click()
    await expect(page.getByText('Vou refazer este card. Na próxima vez ele vem diferente.')).toBeVisible()
    await expect
      .poll(async () => JSON.stringify(await (await page.request.get(`${API}/v1/languages/en/texts/${page.url().split('/').pop()}`)).json()), { timeout: 15_000 })
      .toContain('(refeito)')
    expect(asked.some(call => String((call.body.messages as { content: string }[] | undefined)?.[0]?.content ?? '').includes('Duas opções estão certas'))).toBe(true)
    const kinds = new Set<string>()
    let seen = 0
    for (let guard = 0; guard < 200; guard++) {
      if (await page.getByRole('heading', { name: 'Texto terminado' }).isVisible()) break
      const learn = page.getByRole('button', { name: 'Testar de outro jeito' })
      if (await learn.isVisible()) {
        kinds.add('aprender')
        if (!kinds.has('aprender-shot')) {
          kinds.add('aprender-shot')
          await shot(page, '6c-aprender')
        }
        await learn.click()
        continue
      }
      await expect(page.getByRole('button', { name: 'Conferir' })).toBeVisible()
      // the first listening card: its voice comes from the server before the answer
      if (!voices && (await page.locator('.lg-play-main').count()) > 0) await expect.poll(() => voices, { timeout: 15_000 }).toBeGreaterThan(0)
      kinds.add((await page.locator('.lg-kicker').first().textContent()) ?? '')
      if (seen === 0) await shot(page, '6-card')
      const pieces = page.getByRole('group', { name: 'Peças' })
      const left = page.getByRole('group', { name: 'Esquerda' })
      if (await pieces.isVisible()) {
        if (!kinds.has('montar-shot')) {
          kinds.add('montar-shot')
          await pieces.getByRole('button').first().click()
          await shot(page, '6d-montar')
        }
        while ((await pieces.getByRole('button').count()) > 0) await pieces.getByRole('button').first().click()
      } else if (await left.isVisible()) {
        if (!kinds.has('pares-shot')) {
          kinds.add('pares-shot')
          await left.getByRole('button').first().click()
          await shot(page, '6e-pares')
        }
        const n = await left.getByRole('button').count()
        for (let i = 0; i < n; i++) {
          await left.getByRole('button').nth(i).click()
          await page.getByRole('group', { name: 'Direita' }).getByRole('button', { disabled: false }).first().click()
        }
      } else if ((await page.getByRole('textbox').count()) > 0) for (const field of await page.getByRole('textbox').all()) await field.fill('walk')
      else await page.getByRole('radio').first().click()
      await page.getByRole('button', { name: 'Conferir' }).click()
      await expect(page.getByRole('status').filter({ hasText: /Certo|Não foi/ })).toBeVisible()
      if (seen === 0) await shot(page, '7-retorno')
      if ((await page.getByLabel('O texto').count()) > 0 && !kinds.has('contexto-shot')) {
        kinds.add('contexto-shot')
        await shot(page, '7b-contexto')
      }
      seen++
      await page.getByRole('button', { name: 'Continuar' }).click()
    }
    await expect(page.getByRole('heading', { name: 'Texto terminado' })).toBeVisible()
    expect(seen).toBeGreaterThan(7)
    // the listening cards play the model voice through the server
    expect(voices).toBeGreaterThan(0)
    expect(asked.filter(call => call.path === '/v1/openai/audio/speech').map(call => call.body)).toContainEqual(expect.objectContaining({ model: 'hexgrad/Kokoro-82M', voice: 'af_heart' }))
    // the parts: test (read and listen), practice and context; the learn card after a wrong answer
    const all = [...kinds].join(' | ')
    expect(all).toMatch(/Teste · .*Ler/)
    expect(all).toMatch(/Prática/)
    expect(all).toMatch(/Contexto/)
    expect(kinds.has('aprender')).toBe(true)
    await shot(page, '8-fim')
    const knowledge = (await (await page.request.get(`${API}/v1/languages/en/knowledge`)).json()) as Record<string, Record<string, string>>
    expect(Object.keys(knowledge).length).toBeGreaterThan(0)
  })

  test('5. de volta à página: terminado; recarregar mantém tudo', async () => {
    await page.getByRole('button', { name: 'Voltar' }).click()
    await expect(page).toHaveURL(languageUrl)
    await expect(page.getByText(/você já sabe \d+% · terminado/)).toBeVisible()
    await page.reload()
    await expect(page.getByRole('button', { name: /Estudar de novo/ })).toBeVisible({ timeout: 30_000 })
  })

  // 25/11 (FR-044): "Eu clicaria num cara desses que seria o estudo geral de todos os textos (tudo que foi gerado)"
  test('5b. uma área da base abre o estudo dela, com todos os textos', async () => {
    await page.getByRole('link', { name: 'Léxico' }).click()
    await expect(page).toHaveURL(`${languageUrl}/area/lexico`)
    const parts = page.getByRole('list', { name: 'Partes do estudo' })
    await expect(parts.getByRole('button', { name: /Vocabulário/ })).toBeVisible()
    await expect(parts.getByRole('button', { name: /Contexto/ })).toHaveCount(0)
    await expect(page.getByRole('main', { name: 'Estudo: Léxico' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Conferir' })).toBeVisible()
    await shot(page, '8c-area')
    // the answer goes to the card's own text
    await answerAny(page)
    const saved = page.waitForResponse(response => response.url().endsWith('/v1/languages/en/answers') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Conferir' }).click()
    expect((await saved).status()).toBe(204)
    await page.getByRole('button', { name: 'Sair', exact: true }).click()
    await expect(page).toHaveURL(languageUrl)
  })

  test('6. no celular', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${APP}/idiomas`)
    await expect(page.getByText(/vistos ·/)).toBeVisible({ timeout: 30_000 })
    await shot(page, '9-celular-idiomas')
    await page.goto(languageUrl)
    await expect(page.getByRole('heading', { name: 'Inglês' })).toBeVisible({ timeout: 30_000 })
    await shot(page, '10-celular-idioma')
    await page.getByRole('button', { name: /Estudar de novo/ }).click()
    await expect(page.getByRole('button', { name: 'Conferir' })).toBeVisible()
    await shot(page, '11-celular-card')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })

  test('7. no tema escuro', async () => {
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await answerAny(page)
    await page.getByRole('button', { name: 'Conferir' }).click()
    await shot(page, '12-escuro-card')
    await page.goto(languageUrl)
    await expect(page.getByRole('heading', { name: 'Inglês' })).toBeVisible({ timeout: 30_000 })
    await shot(page, '13-escuro-idioma')
    await page.emulateMedia({ colorScheme: 'light' })
  })

  // 24/11: "Scroll só aqui dentro, não deixe dar scroll no resto do menu" (a lista de PASTAS)
  test('8. muitas pastas: só a lista de pastas rola; o resto do menu fica parado', async () => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1400, height: 760 })
    for (let n = 1; n <= 20; n++) {
      await page.getByRole('treeitem', { name: 'Biblioteca' }).click()
      await page.getByRole('button', { name: 'Nova pasta' }).first().click()
      await page.getByRole('dialog', { name: 'Nova pasta' }).getByLabel('Nome', { exact: true }).fill(`Pasta ${String(n).padStart(2, '0')}`)
      await page.getByRole('button', { name: 'Criar pasta' }).click()
      await expect(page.getByRole('dialog', { name: 'Nova pasta' })).toBeHidden()
    }
    await expect(page.getByRole('treeitem', { name: 'Pasta 20' })).toBeAttached()
    const measure = () =>
      page.evaluate(() => {
        const nav = document.querySelector('.c1 .nav') as HTMLElement
        const tree = nav.querySelector('[role="tree"]') as HTMLElement
        const end = nav.querySelector('.nav-end') as HTMLElement
        return {
          navScrolls: nav.scrollHeight > nav.clientHeight,
          treeScrolls: tree.scrollHeight > tree.clientHeight,
          endBottom: end.getBoundingClientRect().bottom,
          navBottom: nav.getBoundingClientRect().bottom,
        }
      })
    const big = await measure()
    expect(big.navScrolls).toBe(false)
    expect(big.treeScrolls).toBe(true)
    expect(big.endBottom).toBeLessThanOrEqual(big.navBottom + 1)
    // the wheel over the folders scrolls only them
    const before = await page.getByRole('button', { name: 'Idiomas', exact: true }).boundingBox()
    await page.getByRole('treeitem', { name: 'Pasta 05' }).hover()
    await page.mouse.wheel(0, 600)
    await expect(page.getByRole('treeitem', { name: 'Pasta 20' })).toBeInViewport()
    expect(await page.getByRole('button', { name: 'Idiomas', exact: true }).boundingBox()).toEqual(before)
    await shot(page, '14-menu-muitas-pastas')
    // a short window: the folders never disappear (at least ~4 rows), then the whole menu scrolls
    await page.setViewportSize({ width: 1400, height: 420 })
    const treeHeight = await page.getByRole('tree', { name: 'Pastas' }).evaluate(tree => tree.clientHeight)
    expect(treeHeight).toBeGreaterThanOrEqual(120)
  })
})
