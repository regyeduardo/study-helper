import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { expect, test } from '@playwright/test'

import { FakeDrive, useFakeGoogle } from '../fixtures/fake-google'

/** Only for writing the measures: opens the seeded library and saves what each screen offers (aria snapshot and a picture). */
const API = `http://localhost:${process.env.E2E_API_PORT}`
const APP = `http://localhost:${process.env.E2E_APP_PORT}`

test('explorar', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await useFakeGoogle(context, new FakeDrive(), API)
  const login = await context.request.post(`${API}/v1/auth/password/login`, { data: { email: 'pessoa@teste.local', password: 'senha-de-teste-123' }, headers: { Origin: APP, 'X-Estudo': '1' } })
  expect(login.status(), await login.text()).toBeLessThan(300)
  const page = await context.newPage()
  const limit = page.getByRole('dialog', { name: 'Quanto o app pode usar do seu Drive?' })
  await page.addLocatorHandler(limit, dialog => dialog.getByRole('button', { name: 'Salvar' }).click())
  const out = process.env.E2E_DIR!
  const save = async (name: string) => {
    await page.waitForTimeout(1500)
    writeFileSync(path.join(out, `${name}.aria.yml`), await page.locator('body').ariaSnapshot())
    await page.screenshot({ path: path.join(out, `${name}.png`) })
  }
  await page.goto(APP)
  await expect(page.getByRole('button', { name: 'Configurações' }).first()).toBeVisible({ timeout: 60_000 })
  await save('inicio')
  await page.goto(`${APP}/biblioteca/seed-folder-001`)
  await save('pasta-grande')
  await page.goto(`${APP}/arquivo/seed-note-0001`)
  await save('nota-texto')
  await page.goto(`${APP}/arquivo/seed-rec-001`)
  await save('nota-midia')
  await page.goto(`${APP}/gravacoes`)
  await save('gravacoes')
  await page.goto(`${APP}/biblioteca/seed-folder-001`)
  await page.waitForTimeout(1500)
  const alvo = await page.getByRole('main').getByText('Nota de estudo 0010', { exact: true }).first().elementHandle()
  writeFileSync(path.join(out, 'alvo.txt'), (await alvo!.evaluate(el => el.outerHTML.slice(0, 300) + ' | parent ' + el.parentElement!.outerHTML.slice(0, 200))) + '')
  await alvo!.evaluate(el => (el as HTMLElement).click())
  await page.waitForTimeout(3000)
  writeFileSync(path.join(out, 'depois-clique.txt'), page.url() + '\n' + (await page.getByRole('main').textContent())!.slice(0, 3000))
  await page.goto(`${APP}/biblioteca/seed-folder-001`)
  await page.getByRole('main').getByPlaceholder(/Buscar em nomes/).fill('Nota de estudo 0011')
  await page.waitForTimeout(2000)
  writeFileSync(path.join(out, 'busca.txt'), (await page.getByRole('main').textContent())!.slice(0, 2000))
})
