import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { type Browser, expect, type Page, test } from '@playwright/test'

import { FakeDrive, useFakeGoogle } from '../fixtures/fake-google'

/**
 * The pictures of the new screens of spec 007, for the three design reviews (constitution I; T092, T117, T128, T142): Gerações with
 * the account's jobs, the Compartilhar window with the deadline, the list of shared links, the page /s/{id}, the expired link (in the app
 * and in /s/{id}) and Armazenamento with "Liberar espaço", on a computer and on a phone. Run through the perf config with PERF_TELAS=1
 * and a small library; the pictures go to PERF_TELAS_DIR.
 */
const API = `http://localhost:${process.env.E2E_API_PORT}`
const APP = `http://localhost:${process.env.E2E_APP_PORT}`
const OUT = process.env.PERF_TELAS_DIR ?? path.join(process.env.E2E_DIR!, 'telas')
mkdirSync(OUT, { recursive: true })

async function signedIn(browser: Browser, viewport: { width: number; height: number }, mobile = false): Promise<Page> {
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 })
  await useFakeGoogle(context, new FakeDrive(), API)
  const login = await context.request.post(`${API}/v1/auth/password/login`, { data: { email: 'pessoa@teste.local', password: 'senha-de-teste-123' }, headers: { Origin: APP, 'X-Estudo': '1' } })
  expect(login.status(), await login.text()).toBeLessThan(300)
  const page = await context.newPage()
  // a step that does not find its button fails in 20 s and the next picture goes on
  page.setDefaultTimeout(20_000)
  await page.addLocatorHandler(page.getByRole('dialog', { name: 'Quanto o app pode usar do seu Drive?' }), dialog => dialog.getByRole('button', { name: 'Salvar' }).click())
  await page.goto(APP)
  // on a phone the sidebar hides behind the "Menu" button of the top bar: that button stands for it
  await expect(page.getByRole('button', { name: 'Configurações' }).or(page.getByRole('button', { name: /^Menu/ })).first()).toBeAttached({ timeout: 60_000 })
  return page
}

const errors: string[] = []
async function shot(page: Page, name: string, run: () => Promise<void>) {
  try {
    await run()
    await page.waitForTimeout(800)
    await page.screenshot({ path: path.join(OUT, `${name}.png`) })
  } catch (error) {
    errors.push(`${name}: ${String(error).split('\n')[0]}`)
  }
}

async function api(page: Page, method: string, url: string, data?: unknown) {
  const response = await page.context().request.fetch(`${API}${url}`, { method, data, headers: { Origin: APP, 'X-Estudo': '1' } })
  return (await response.json().catch(() => ({}))) as Record<string, unknown>
}

test('telas da spec 007', async ({ browser }) => {
  test.setTimeout(15 * 60_000)
  for (const [device, viewport, mobile] of [
    ['computador', { width: 1400, height: 900 }, false],
    ['celular', { width: 390, height: 844 }, true],
  ] as const) {
    const page = await signedIn(browser, viewport, mobile)

    // Gerações with jobs of the account (without a Chromium on this server they fail at once, with the reason and "Tentar de novo")
    if (device === 'computador') {
      await api(page, 'POST', '/v1/jobs', { call: 'generateFromNote', args: ['seed-note-0001', 'explanation'], fileId: 'seed-note-0001', title: 'Explicação · Nota de estudo 0001' })
      await api(page, 'POST', '/v1/jobs', { call: 'suggestTags', args: ['seed-note-0002'], fileId: 'seed-note-0002', title: 'Etiquetas · Nota de estudo 0002' })
    }
    await shot(page, `${device}-geracoes`, async () => {
      await page.goto(`${APP}/geracoes`)
      await page.waitForTimeout(2500)
    })
    await shot(page, `${device}-geracoes-prontas`, async () => {
      await page.getByRole('tab', { name: /Prontas/ }).or(page.getByRole('button', { name: /Prontas/ })).first().click()
    })

    // Compartilhar, with the deadline (a meeting kept in the App: live link)
    await shot(page, `${device}-compartilhar-janela`, async () => {
      await page.goto(`${APP}/biblioteca/seed-folder-002`)
      await page.getByRole('main').getByRole('button', { name: 'Opções de Reunião de teste 001' }).click()
      await page.getByRole('button', { name: 'Compartilhar', exact: true }).first().click()
      await expect(page.getByRole('dialog').first()).toBeVisible()
    })
    await shot(page, `${device}-compartilhar-feito`, async () => {
      const dialog = page.getByRole('dialog').first()
      await dialog.getByRole('radio', { name: /7 dias/ }).or(dialog.getByRole('button', { name: /7 dias/ })).first().click()
      await dialog.getByRole('button', { name: 'Compartilhar', exact: true }).click()
      await expect(dialog.getByText(/Copiar/).first()).toBeVisible({ timeout: 20_000 })
    })
    await page.keyboard.press('Escape')

    await shot(page, `${device}-compartilhados`, async () => {
      await page.goto(`${APP}/compartilhados`)
      await page.waitForTimeout(2000)
    })

    // Armazenamento and "Liberar espaço"
    await shot(page, `${device}-armazenamento`, async () => {
      await page.goto(APP)
      // on a phone the side bar opens from the "Menu" button of the top bar
      if (mobile) await page.getByRole('button', { name: /^Menu/ }).click()
      await page.getByRole('button', { name: 'Configurações' }).first().click()
      const settings = page.getByRole('dialog', { name: 'Configurações' })
      await settings.getByRole('button', { name: /Armazenamento/ }).first().click()
      await expect(settings.getByText(/de 10 GB/).first()).toBeVisible({ timeout: 20_000 })
    })
    await shot(page, `${device}-liberar-espaco`, async () => {
      const settings = page.getByRole('dialog', { name: 'Configurações' })
      await settings.getByRole('button', { name: /Liberar espaço/ }).first().click()
      await page.waitForTimeout(1500)
    })
    await page.keyboard.press('Escape')

    // the page that agents read, and the expired link (in the app and in /s/{id})
    const links = (await api(page, 'GET', '/v1/shares')) as { links?: { id: string; expiresIn: string }[] }
    const link = links.links?.[0]
    if (link) {
      await shot(page, `${device}-pagina-s`, async () => {
        await page.goto(`${API}/s/${link.id}`, { waitUntil: 'commit' }).catch(() => undefined)
        // the page sends people to the app: the picture is of the page itself, read with the script off
      })
      const reader = await browser.newContext({ viewport, isMobile: mobile, javaScriptEnabled: false, deviceScaleFactor: mobile ? 2 : 1 })
      const raw = await reader.newPage()
      raw.setDefaultTimeout(20_000)
      await shot(raw, `${device}-pagina-s-sem-script`, async () => {
        await raw.goto(`${API}/s/${link.id}`)
      })
      const db = new DatabaseSync(path.join(process.env.E2E_DIR!, 'estudo.db'))
      db.exec('PRAGMA busy_timeout = 5000')
      db.prepare(`UPDATE shared_links SET expires_at = '2026-01-01T00:00:00Z' WHERE id = ?`).run(link.id)
      db.close()
      await shot(raw, `${device}-pagina-s-vencida`, async () => {
        await raw.goto(`${API}/s/${link.id}`)
      })
      await shot(page, `${device}-link-vencido-app`, async () => {
        await page.goto(`${APP}/shared/${link.id}`)
        await page.waitForTimeout(2500)
      })
      await reader.close()
    }
    await page.context().close()
  }
  writeFileSync(path.join(OUT, 'falhas.txt'), errors.join('\n'))
})
