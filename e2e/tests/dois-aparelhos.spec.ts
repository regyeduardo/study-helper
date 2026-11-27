import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { type BrowserContext, expect, type Page, test } from '@playwright/test'

import { FakeDrive, useFakeGoogle } from '../fixtures/fake-google'

/**
 * T068 (spec 003, história 2): the same library on two devices, one account, "Usar a estrutura do app" on. A change made on one
 * device shows on the other in up to 10 s without reloading (SC-004), through the App's live channel.
 * Run: cd e2e && npm run test:dois-aparelhos (backend and app of its own, see playwright.dois-aparelhos.config.ts).
 */

const APP = `http://localhost:${process.env.E2E_APP_PORT}`
const API = `http://localhost:${process.env.E2E_API_PORT}`
const SC004 = 10_000
const PASSWORD = 'senha-de-teste-123'
// a new account and code each run (and each --repeat-each)
let EMAIL = ''
let CODE = ''
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'
const FIRST_TEXT = 'Juros compostos rendem sobre o que já rendeu.'
const EDITED_TEXT = 'Juros compostos rendem sobre o que já rendeu. Texto mudado no aparelho 2.'

/** The invitation code, written straight into this run's own database (the admin screen needs a Google-proven e-mail). */
function createCode(): void {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
  // the same person as the fake Google account: the hierarchy is the account's (spec 005)
  EMAIL = 'pessoa@teste.local'
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

/** A short tone, as a WAV file. */
function tone(seconds: number): Buffer {
  const rate = 8000
  const samples = rate * seconds
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

/** How long a change took, from the click on one device (`since`) until it shows on the other; fails past SC-004. */
async function arrives(what: string, since: number, check: (timeout: number) => Promise<void>): Promise<void> {
  await check(Math.max(1, SC004 - (Date.now() - since)))
  console.log(`  ${what}: ${((Date.now() - since) / 1000).toFixed(1)} s desde o clique`)
}

/**
 * Opens the app and waits for it on screen. A change in the machine's network (ERR_NETWORK_CHANGED, e.g. a Docker network coming
 * up) can drop the first load's modules and leave a blank page: then it loads again, at most 3 times.
 */
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

function settingsOf(page: Page) {
  return page.getByRole('dialog', { name: 'Configurações' })
}

async function openSettings(page: Page, section: string) {
  await page.getByRole('button', { name: 'Configurações' }).first().click()
  await settingsOf(page).getByRole('button', { name: section, exact: true }).click()
  return settingsOf(page)
}

async function closeSettings(page: Page) {
  await settingsOf(page).getByRole('button', { name: 'Fechar', exact: true }).click()
  await expect(settingsOf(page)).toBeHidden()
}

/** Configurações › Outros › "Usar a estrutura do app": the account (made here with the code, or signed in), then on. */
async function turnOnStructure(page: Page, how: 'create' | 'sign-in') {
  const settings = await openSettings(page, 'Outros')
  await settings.getByRole('switch', { name: 'Usar a estrutura do app' }).click()
  const signIn = page.getByRole('dialog', { name: 'Entrar no Estudo' })
  if (how === 'create') {
    await signIn.getByRole('button', { name: 'Não tem conta? Criar com e-mail e senha' }).click()
    await signIn.getByLabel('Nome').fill('Pessoa Teste')
  }
  await signIn.getByLabel('E-mail').fill(EMAIL)
  await signIn.getByLabel('Senha', { exact: true }).fill(PASSWORD)
  await signIn.getByRole('button', { name: how === 'create' ? 'Criar conta' : 'Entrar', exact: true }).click()
  // spec 005: with the session, the hierarchy goes to the account once, in the window that holds the app for a few seconds
  await expect
    .poll(async () => ((await (await page.request.get(`${API}/v1/me`)).json()) as { user?: { hierarchyAt?: string | null } }).user?.hierarchyAt ?? null, { timeout: 60_000 })
    .not.toBeNull()
  await expect(page.getByText('Levando a biblioteca para a sua conta')).toBeHidden({ timeout: 60_000 })
  if (how === 'create') {
    const code = page.getByRole('dialog', { name: 'Usar a estrutura do app' })
    await code.getByLabel('Código').fill(CODE)
    await code.getByRole('button', { name: 'Liberar' }).click()
  }
  await expect(settings.getByText('A estrutura do app está ligada nesta conta.')).toBeVisible()
  await expect(settings.getByRole('switch', { name: 'Usar a estrutura do app' })).toHaveAttribute('aria-checked', 'true')
  await closeSettings(page)
}

/** The rows of the library the server keeps for the account (what is really in the App). */
async function appRows(page: Page): Promise<{ name: string; itemKind: string; trashedAt: string | null; media: unknown }[]> {
  const response = await page.request.get(`${API}/v1/library/map?since=0&limit=1000`)
  expect(response.status()).toBe(200)
  return ((await response.json()) as { rows: { name: string; itemKind: string; trashedAt: string | null; media: unknown }[] }).rows
}

test.describe.serial('dois aparelhos, a mesma conta, a estrutura do app ligada', () => {
  let drive: FakeDrive
  let one: BrowserContext
  let two: BrowserContext
  let device1: Page
  let device2: Page
  let noteId = ''

  test.beforeAll(async ({ browser }) => {
    createCode()
    drive = new FakeDrive()
    one = await browser.newContext({ viewport: { width: 1400, height: 900 }, userAgent: LINUX })
    two = await browser.newContext({ viewport: { width: 1400, height: 900 }, userAgent: WINDOWS })
    for (const context of [one, two]) await useFakeGoogle(context, drive, API)
    device1 = await one.newPage()
    device2 = await two.newPage()
    for (const page of [device1, device2]) {
      // the first visit asks how much of the Drive the app may use: the default answer is enough here
      const limit = page.getByRole('dialog', { name: 'Quanto o app pode usar do seu Drive?' })
      await page.addLocatorHandler(limit, dialog => dialog.getByRole('button', { name: 'Salvar' }).click())
    }
    await openApp(device1)
    await turnOnStructure(device1, 'create')
    await openApp(device2)
    await turnOnStructure(device2, 'sign-in')
  })

  test.afterAll(async () => {
    await one?.close()
    await two?.close()
  })

  test('1. o aparelho 1 cria uma pasta e uma nota no App; o aparelho 2 vê as duas sem recarregar', async () => {
    await device1.getByRole('treeitem', { name: 'Biblioteca' }).click()
    await device1.getByRole('button', { name: 'Nova pasta' }).first().click()
    await device1.getByRole('dialog', { name: 'Nova pasta' }).getByLabel('Nome', { exact: true }).fill('Faculdade')
    await device1.getByRole('button', { name: 'Criar pasta' }).click()
    const moved = Date.now()
    await expect(device1).toHaveURL(/\/biblioteca\/.+/)
    // spec 005: a folder has no place; it is in the account's hierarchy, and a new note goes to the App by itself (structure on)
    await arrives('pasta no aparelho 2', moved, timeout => expect(device2.getByRole('treeitem', { name: 'Faculdade' })).toBeVisible({ timeout }))

    await device2.getByRole('treeitem', { name: 'Faculdade' }).click()
    await device1.getByRole('button', { name: 'Novo', exact: true }).first().click()
    const fresh = device1.getByRole('dialog', { name: 'Novo conteúdo' })
    await fresh.getByRole('button', { name: 'Texto', exact: true }).click()
    await fresh.getByRole('textbox', { name: 'Texto' }).fill(FIRST_TEXT)
    await fresh.getByRole('radio', { name: /Só guardar para ler/ }).click()
    await fresh.getByLabel('Nome (opcional)').fill('Aula 1')
    await expect(fresh.getByRole('group', { name: 'Pasta' })).toContainText('Faculdade')
    const saved = Date.now()
    await fresh.getByRole('button', { name: 'Guardar', exact: true }).click()
    await expect(device1).toHaveURL(/\/arquivo\/.+/)
    noteId = device1.url().split('/arquivo/')[1].split(/[?#]/)[0]
    await expect(device1.getByText(FIRST_TEXT)).toBeVisible()
    await arrives('nota no aparelho 2', saved, timeout => expect(device2.getByRole('button', { name: 'Opções de Aula 1' })).toBeVisible({ timeout }))

    // both are kept in the App (the server's map), and nothing of them in the Google Drive
    const rows = await appRows(device1)
    expect(rows.filter(row => !row.trashedAt).map(row => `${row.itemKind}:${row.name}`).sort()).toEqual(['file:Aula 1', 'folder:Faculdade'])
    const inDrive = [...drive.files.values()].map(file => `${file.name} ${file.content?.toString('utf8') ?? ''}`).join('\n')
    expect(inDrive).not.toContain(FIRST_TEXT)
    expect(inDrive).not.toContain(noteId)
  })

  test('2. o aparelho 2 edita o texto e o nome da nota; o aparelho 1 vê a mudança', async () => {
    await device2.getByRole('button', { name: 'Opções de Aula 1' }).locator('xpath=ancestor::tr').getByText('Aula 1', { exact: true }).click()
    await expect(device2).toHaveURL(new RegExp(`/arquivo/${noteId}`))
    await expect(device2.getByText(FIRST_TEXT)).toBeVisible()

    // the text: the app has no text editor on screen, so device 2 saves through the library's own saveContent (the path every
    // change of a note's text takes, as Details does)
    const edited = Date.now()
    await device2.evaluate(
      async ({ id, text }) => {
        // the app's own module, as Vite serves it (a string import, so the test's compiler leaves it to the browser)
        const { useLibraryStore } = await new Function('url', 'return import(url)')('/src/stores/library.ts')
        await useLibraryStore.getState().saveContent(id, text)
      },
      { id: noteId, text: EDITED_TEXT },
    )
    await arrives('texto novo no aparelho 1', edited, timeout => expect(device1.getByText(EDITED_TEXT)).toBeVisible({ timeout }))

    // the name, through the screen: ⋯ › Renomear
    await device2.getByRole('button', { name: 'Mais opções do documento' }).click()
    await device2.getByRole('button', { name: 'Renomear' }).click()
    const rename = device2.getByRole('dialog', { name: 'Renomear arquivo' })
    await rename.getByLabel('Nome', { exact: true }).fill('Aula 1 revisada')
    const renamed = Date.now()
    await rename.getByRole('button', { name: 'Salvar' }).click()
    await expect(rename).toBeHidden()
    await arrives('nome novo no aparelho 1', renamed, timeout => expect(device1.getByRole('heading', { name: 'Aula 1 revisada' })).toBeVisible({ timeout }))
    await expect(device1.getByText(EDITED_TEXT)).toBeVisible()
  })

  test('3. o aparelho 1 apaga a nota; ela some no aparelho 2', async () => {
    await device2.getByRole('treeitem', { name: 'Faculdade' }).click()
    await expect(device2.getByRole('button', { name: 'Opções de Aula 1 revisada' })).toBeVisible()
    await device1.getByRole('button', { name: 'Mais opções do documento' }).click()
    const deleted = Date.now()
    await device1.getByRole('button', { name: 'Apagar' }).click()
    await expect(device1.getByText('"Aula 1 revisada" foi para a lixeira')).toBeVisible()
    await arrives('nota apagada some no aparelho 2', deleted, timeout => expect(device2.getByRole('button', { name: 'Opções de Aula 1 revisada' })).toBeHidden({ timeout }))
    const note = (await appRows(device1)).find(row => row.name === 'Aula 1 revisada')
    expect(note?.trashedAt).toBeTruthy()
  })

  test('4. a lista de aparelhos mostra os dois; sair de um pelo outro derruba a sessão dele', async () => {
    const devices = await openSettings(device1, 'Dispositivos')
    const table = devices.locator('table.acc-table')
    await expect(table.locator('tbody tr')).toHaveCount(2)
    await expect(table).toContainText('Chrome no Linux · este aparelho')
    await expect(table).toContainText('Chrome no Windows')
    await devices.getByRole('button', { name: 'Sair de Chrome no Windows' }).click()
    await expect(table.locator('tbody tr')).toHaveCount(1)
    await closeSettings(device1)

    // device 2's session is gone on the server at once
    expect((await device2.request.get(`${API}/v1/me`)).status()).toBe(401)
    // and its screen: opening the app again, it is out of the account and the App's library is not there
    await openApp(device2)
    const others = await openSettings(device2, 'Outros')
    await expect(others.getByText('Ao ligar, você entra na sua conta do Estudo primeiro.')).toBeVisible()
    await expect(others.getByRole('switch', { name: 'Usar a estrutura do app' })).toHaveAttribute('aria-checked', 'false')
    await closeSettings(device2)
    await expect(device2.getByRole('treeitem', { name: 'Faculdade' })).toBeHidden()
    // device 1 goes on
    expect((await device1.request.get(`${API}/v1/me`)).status()).toBe(200)
  })

  test('5. uma mídia pequena enviada no aparelho 1 toca no aparelho 2', async () => {
    await turnOnStructure(device2, 'sign-in')
    await device2.getByRole('treeitem', { name: 'Faculdade' }).click()
    await device1.getByRole('treeitem', { name: 'Faculdade' }).click()
    await expect(device1).toHaveURL(/\/biblioteca\/.+/)
    const folderId = device1.url().split('/biblioteca/')[1].split(/[?#]/)[0]

    // "Novo › Arquivo" asks for a transcription model, which the structure does not give yet (entrega 5): the media note is made
    // the way "Só guardar para ler" makes it (a note, then the media kept with it), through the app's own functions
    const uploaded = Date.now()
    const sent = await device1.evaluate(
      async ({ folderId, wav }) => {
        const load = new Function('url', 'return import(url)')
        const { useLibraryStore } = await load('/src/stores/library.ts')
        const { storeSource } = await load('/src/lib/storage/source-storage.ts')
        const bytes = Uint8Array.from(atob(wav), char => char.charCodeAt(0))
        const file = new File([bytes], 'tom.wav', { type: 'audio/wav' })
        const origin = { input: 'file', name: 'tom.wav', mime: 'audio/wav', sizeBytes: file.size, durationSeconds: 2, storage: 'none' }
        const meta = await useLibraryStore.getState().createFile({ name: 'Áudio de teste', type: 'audio', folderId, status: 'ready', origin, kept: 'registro' }, '')
        const stored = await storeSource(file, 'drive', meta.id, useLibraryStore.getState().repo, '72h')
        await useLibraryStore.getState().updateFile(meta.id, { origin: { ...origin, ...stored }, kept: 'arquivo' })
        return { id: meta.id as string, ref: (stored.storedFileId ?? '') as string }
      },
      { folderId, wav: tone(2).toString('base64') },
    )
    expect(sent.ref).toMatch(/^app:/)
    const media = (await appRows(device1)).find(row => row.name === 'Áudio de teste')?.media as { status?: string; bytes?: number } | null
    expect(media?.status).toBe('stored')

    await arrives('mídia no aparelho 2', uploaded, timeout => expect(device2.getByRole('button', { name: 'Opções de Áudio de teste' })).toBeVisible({ timeout }))
    await device2.getByRole('button', { name: 'Opções de Áudio de teste' }).locator('xpath=ancestor::tr').getByText('Áudio de teste', { exact: true }).click()
    const player = device2.getByRole('region', { name: 'Player da gravação' })
    await expect(player).toBeVisible()
    await player.getByRole('button', { name: 'Tocar' }).click()
    await expect(player.getByRole('button', { name: 'Pausar' })).toBeVisible()
    await expect.poll(() => device2.locator('audio').evaluate(audio => (audio as HTMLAudioElement).currentTime), { timeout: SC004 }).toBeGreaterThan(0.2)
  })
})
