import { type BrowserContext, expect, type Page, test } from '@playwright/test'

import { FakeDrive, useFakeGoogle } from '../fixtures/fake-google'

/**
 * Spec 005 (história 1 e 2): duas instâncias de Chromium, a mesma conta, SEM a estrutura do app. Na primeira abertura a hierarquia
 * vai para a conta (migração); depois, uma pasta criada num aparelho aparece no outro sem recarregar, nos dois sentidos.
 * Run: cd e2e && npx playwright test --config playwright.hierarquia.config.ts
 */

const APP = `http://localhost:${process.env.E2E_APP_PORT}`
const API = `http://localhost:${process.env.E2E_API_PORT}`
// the Google account of the fake Google: the server account must be the same person for the hierarchy to be the account's
const EMAIL = 'pessoa@teste.local'
const PASSWORD = 'senha-de-teste-123'
const SC002 = 10_000

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

async function signIn(context: BrowserContext, how: 'register' | 'login'): Promise<void> {
  const body = how === 'register' ? { email: EMAIL, password: PASSWORD, name: 'Pessoa Teste' } : { email: EMAIL, password: PASSWORD }
  const response = await context.request.post(`${API}/v1/auth/password/${how}`, { data: body, headers: { Origin: APP, 'X-Estudo': '1' } })
  expect(response.status(), await response.text()).toBeLessThan(300)
}

async function hierarchyAt(context: BrowserContext): Promise<string | null> {
  const response = await context.request.get(`${API}/v1/me`)
  return ((await response.json()) as { user: { hierarchyAt: string | null } }).user.hierarchyAt
}

async function newFolder(page: Page, name: string): Promise<void> {
  await page.getByRole('treeitem', { name: 'Biblioteca' }).click()
  await page.getByRole('button', { name: 'Nova pasta' }).first().click()
  await page.getByRole('dialog', { name: 'Nova pasta' }).getByLabel('Nome', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Criar pasta' }).click()
}

test.describe.serial('hierarquia na conta, dois Chromium, sem a estrutura do app', () => {
  let drive: FakeDrive
  let one: BrowserContext
  let two: BrowserContext
  let device1: Page
  let device2: Page

  test.beforeAll(async ({ browser }) => {
    drive = new FakeDrive()
    one = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    two = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    for (const context of [one, two]) await useFakeGoogle(context, drive, API)
    device1 = await one.newPage()
    device2 = await two.newPage()
    for (const page of [device1, device2]) {
      const limit = page.getByRole('dialog', { name: 'Quanto o app pode usar do seu Drive?' })
      await page.addLocatorHandler(limit, dialog => dialog.getByRole('button', { name: 'Salvar' }).click())
    }
    await signIn(one, 'register')
    await signIn(two, 'login')
  })

  test.afterAll(async () => {
    await one?.close()
    await two?.close()
  })

  test('1. a primeira abertura leva a hierarquia para a conta (migração), com a estrutura desligada', async () => {
    await openApp(device1)
    await expect.poll(() => hierarchyAt(one), { timeout: 60_000 }).not.toBeNull()
    await expect(device1.getByText(/Pronto: .* na sua conta\. Nada mudou de lugar\./)).toBeVisible({ timeout: 30_000 })
    await openApp(device2)
  })

  test('2. pasta criada no aparelho 1 aparece no aparelho 2 sem recarregar', async () => {
    const started = Date.now()
    await newFolder(device1, 'Projeto Aurora')
    await expect(device2.getByRole('treeitem', { name: 'Projeto Aurora' })).toBeVisible({ timeout: SC002 })
    console.log(`  pasta no aparelho 2: ${((Date.now() - started) / 1000).toFixed(1)} s`)
  })

  test('3. pasta criada no aparelho 2 aparece no aparelho 1', async () => {
    const started = Date.now()
    await newFolder(device2, 'Contratos')
    await expect(device1.getByRole('treeitem', { name: 'Contratos' })).toBeVisible({ timeout: SC002 })
    console.log(`  pasta no aparelho 1: ${((Date.now() - started) / 1000).toFixed(1)} s`)
  })

  test('4. as pastas estão na conta, sem lugar, e nenhuma pasta foi criada no Google Drive', async () => {
    const response = await one.request.get(`${API}/v1/library/map?since=0&limit=1000`)
    const rows = ((await response.json()) as { rows: { name: string; itemKind: string; place: string | null; removedAt: string | null }[] }).rows
    const folders = rows.filter(row => row.itemKind === 'folder' && !row.removedAt)
    expect(folders.map(row => row.name).sort()).toEqual(['Contratos', 'Projeto Aurora'])
    expect(folders.every(row => row.place === null)).toBe(true)
    const inDrive = [...drive.files.values()].map(file => file.name)
    expect(inDrive).not.toContain('Projeto Aurora')
    expect(inDrive).not.toContain('Contratos')
  })
})
