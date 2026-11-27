import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { type BrowserContext, expect, type Page, test } from '@playwright/test'

import { FakeDrive, useFakeGoogle } from '../fixtures/fake-google'

/**
 * Spec 004, prova de 100% (dono, 23/11 23:34 "Fecha 100%"): the real app AI and voice, in real Chromium, with a local S3 in place of R2.
 * A short text and a long one (60 lines, written for this test), the real model voice decoded by the browser, "Reportar" made again by the
 * other model, and the word cache in the S3. Run: see playwright.idiomas-real.config.ts.
 */

const APP = `http://localhost:${process.env.E2E_APP_PORT}`
const API = `http://localhost:${process.env.E2E_API_PORT}`
const PASSWORD = 'senha-de-teste-123'
const EMAIL = 'pessoa@teste.local'
const SHOTS = process.env.E2E_SHOTS ?? path.join(process.env.E2E_DIR!, 'shots')
let CODE = ''
const SHORT = [
  'I used to take the early train to work every morning.',
  "Now I'd rather walk, even when it's raining.",
  "My neighbor thinks I'm crazy, but I don't mind.",
  '"You\'re gonna catch a cold," she told me yesterday.',
  "I guess she's right, but I've never felt better.",
]
const LONG = readFileSync(path.resolve(__dirname, '../fixtures/texto-longo-en.txt'), 'utf8')

/** What the local S3 has under a prefix (through MinIO's own client, inside its container). */
function s3(prefix: string): string {
  return execFileSync('docker', ['exec', 'estudo-minio-teste', 'sh', '-c', `mc alias set l http://127.0.0.1:9000 estudoteste estudoteste123 >/dev/null && mc ls --recursive l/estudo-teste/${prefix}`]).toString()
}

type TextOut = { lines: string[]; items: Record<string, { label: string; test: { id: string; q: string; skill: string; type: string }[] }>; practice: { type: string; skill: string }[]; context: { type: string; skill: string }[] }

async function textOf(page: Page, id: string): Promise<TextOut> {
  return (await (await page.request.get(`${API}/v1/languages/en/texts/${id}`)).json()) as TextOut
}

function stats(text: TextOut) {
  const cards = [...Object.values(text.items).flatMap(item => item.test), ...text.practice, ...text.context]
  const count = (type: string) => cards.filter(card => card.type === type).length
  return { lines: text.lines.length, items: Object.keys(text.items).length, cards: cards.length, listening: cards.filter(card => card.skill === 'listen').length, dictation: count('dictation') }
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true })
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


test.describe.serial('Idiomas com a IA e a voz de verdade', () => {
  let context: BrowserContext
  let page: Page
  let shortId = ''

  test.beforeAll(async ({ browser }) => {
    createCode()
    const drive = new FakeDrive()
    context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await useFakeGoogle(context, drive, API)
    page = await context.newPage()
    await page.addLocatorHandler(page.getByRole('dialog', { name: 'Quanto o app pode usar do seu Drive?' }), dialog => dialog.getByRole('button', { name: 'Salvar' }).click())
    await openApp(page)
    await turnOnStructure(page)
  })

  test.afterAll(async () => {
    await context?.close()
  })

  test('1. texto curto gerado pela IA real', async () => {
    await page.goto(`${APP}/idiomas`)
    await page.getByRole('button', { name: 'Novo idioma' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Novo idioma' })
    await dialog.getByRole('radio', { name: /Inglês/ }).click()
    await dialog.getByRole('button', { name: 'Criar' }).click()
    await page.getByRole('button', { name: 'Novo texto' }).first().click()
    const write = page.getByRole('dialog', { name: 'Novo texto em Inglês' })
    await write.getByLabel('Título').fill('Trem e chuva')
    await write.getByLabel('Texto').fill(SHORT.join('\n'))
    const started = Date.now()
    await write.getByRole('button', { name: 'Mandar' }).click()
    await expect(page.getByRole('button', { name: /Começar/ })).toBeVisible({ timeout: 4 * 60_000 })
    const list = (await (await page.request.get(`${API}/v1/languages/en`)).json()) as { texts: { id: string }[] }
    shortId = list.texts[0].id
    const got = stats(await textOf(page, shortId))
    console.log(`  texto curto: ${((Date.now() - started) / 1000).toFixed(0)} s`, JSON.stringify(got))
    expect(got.lines).toBe(5)
    expect(got.items).toBeGreaterThanOrEqual(4)
    expect(got.listening).toBeGreaterThanOrEqual(8)
    expect(got.dictation).toBeGreaterThanOrEqual(3)
  })

  test('2. a voz modelo de verdade toca no navegador, com o silêncio antes, e fica guardada', async () => {
    await page.getByRole('button', { name: /Começar/ }).click()
    const voice = page.waitForResponse(response => response.url().endsWith('/v1/speech/tts') && response.request().method() === 'POST', { timeout: 60_000 })
    await page.getByRole('button', { name: `Ouvir: ${SHORT[0]}` }).click()
    const answer = await voice
    expect(answer.status()).toBe(200)
    const decoded = await page.evaluate(
      async ({ api, text }) => {
        const response = await fetch(`${api}/v1/speech/tts`, { method: 'POST', credentials: 'include', headers: { 'X-Estudo': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ text, locale: 'en-US' }) })
        const blob = await response.blob()
        const audio = new Audio(URL.createObjectURL(blob))
        await new Promise((ok, fail) => {
          audio.onloadedmetadata = ok
          audio.onerror = () => fail(new Error(`audio error ${audio.error?.code}`))
        })
        return { type: blob.type, size: blob.size, duration: audio.duration }
      },
      { api: API, text: SHORT[0] },
    )
    console.log('  voz:', JSON.stringify(decoded))
    expect(decoded.type).toBe('audio/mpeg')
    expect(decoded.duration).toBeGreaterThan(1.5)
    expect(s3('lang/tts/')).toMatch(/\.mp3/)
  })

  test('3. todos os cards de ouvir e um "Reportar" refeito pelo outro modelo', async () => {
    await page.getByRole('button', { name: /Começar os cards de ouvir/ }).click()
    await expect(page.getByRole('button', { name: 'Conferir' })).toBeVisible()
    await shot(page, 'real-1-card')
    const before = JSON.stringify(await textOf(page, shortId))
    await page.getByRole('button', { name: 'Reportar este card' }).click()
    const report = page.getByRole('dialog', { name: 'Reportar este card' })
    await report.getByRole('radio', { name: 'O enunciado confunde' }).click()
    await report.getByRole('button', { name: 'Refazer o card' }).click()
    await expect(page.getByText('Vou refazer este card.', { exact: false })).toBeVisible()
    await expect.poll(async () => JSON.stringify(await textOf(page, shortId)) !== before, { timeout: 120_000, intervals: [3_000] }).toBe(true)
    let seen = 0
    for (let guard = 0; guard < 120; guard++) {
      if (await page.getByRole('heading', { name: 'Texto terminado' }).isVisible()) break
      await expect(page.getByRole('button', { name: 'Conferir' })).toBeVisible({ timeout: 30_000 })
      const fields = page.getByRole('textbox')
      if ((await fields.count()) > 0) for (const field of await fields.all()) await field.fill('walk')
      else await page.getByRole('radio').first().click()
      await page.getByRole('button', { name: 'Conferir' }).click()
      await page.getByRole('button', { name: 'Continuar' }).click()
      seen++
    }
    await expect(page.getByRole('heading', { name: 'Texto terminado' })).toBeVisible()
    console.log(`  cards respondidos: ${seen}`)
  })

  test('4. as palavras ficaram no S3 para todos', async () => {
    const listed = s3('lang/items/en/')
    console.log(`  itens no S3: ${listed.trim().split('\n').length}`)
    expect(listed).toMatch(/index\.json/)
    expect(listed).toMatch(/used_to[^ ]*\.json/)
  })

  test('5. texto longo (60 linhas) com a IA real', async () => {
    await page.goto(`${APP}/idiomas/en`)
    await page.getByRole('button', { name: 'Novo texto' }).first().click()
    const write = page.getByRole('dialog', { name: 'Novo texto em Inglês' })
    await write.getByLabel('Título').fill('A casa da avó')
    await write.getByLabel('Texto').fill(LONG)
    const started = Date.now()
    await write.getByRole('button', { name: 'Mandar' }).click()
    await expect(page.getByText('Preparando as frases e os cards…')).toBeVisible()
    await expect(page.getByRole('button', { name: /Começar/ })).toBeVisible({ timeout: 12 * 60_000 })
    const list = (await (await page.request.get(`${API}/v1/languages/en`)).json()) as { texts: { id: string; title: string }[] }
    const id = list.texts.find(text => text.title === 'A casa da avó')!.id
    const got = stats(await textOf(page, id))
    console.log(`  texto longo: ${((Date.now() - started) / 1000).toFixed(0)} s`, JSON.stringify(got))
    expect(got.lines).toBe(60)
    expect(got.items).toBeGreaterThanOrEqual(30)
    expect(got.listening).toBeGreaterThanOrEqual(60)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${APP}/idiomas/en/${id}`)
    await expect(page.getByRole('heading', { name: 'A casa da avó' })).toBeVisible({ timeout: 30_000 })
    await shot(page, 'real-2-longo-celular')
  })
})
