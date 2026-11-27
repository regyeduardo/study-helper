import { writeFileSync } from 'node:fs'

import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test'

import { FakeDrive, useFakeGoogle } from '../fixtures/fake-google'
import { medir, medirAbertura, medirDigitando, type Medida } from './operations'

/**
 * The measures of spec 007 (FR-001, research R1; ids and targets in contracts/ui.md), on the seeded test library. PERF_PERFIL picks the
 * profile: "computador" as it is, "celular" with the CPU 4x slower and a mobile network (150 ms, 9 Mb/s down, 1.5 Mb/s up). Each
 * operation runs PERF_RODADAS times; the raw measures go to PERF_SAIDA, and run.mjs turns them into medians and the readable table.
 */

const API = `http://localhost:${process.env.E2E_API_PORT}`
const APP = `http://localhost:${process.env.E2E_APP_PORT}`
const EMAIL = 'pessoa@teste.local'
const PASSWORD = 'senha-de-teste-123'
const PERFIS = (process.env.PERF_PERFIS ?? 'computador').split(',').filter(Boolean)
const RODADAS = Number(process.env.PERF_RODADAS ?? 5)
const SO = process.env.PERF_SO ? new Set(process.env.PERF_SO.split(',')) : null
const resultados: (Medida & { perfil: string; rodada: number })[] = []
const falhas: { perfil: string; op: string; rodada: number; erro: string }[] = []

const pad = (n: number, size: number) => String(n).padStart(size, '0')

async function contexto(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await useFakeGoogle(context, new FakeDrive(), API)
  const login = await context.request.post(`${API}/v1/auth/password/login`, { data: { email: EMAIL, password: PASSWORD }, headers: { Origin: APP, 'X-Estudo': '1' } })
  expect(login.status(), await login.text()).toBeLessThan(300)
  return context
}

async function pagina(context: BrowserContext, PERFIL: string): Promise<Page> {
  const page = await context.newPage()
  await page.addLocatorHandler(page.getByRole('dialog', { name: 'Quanto o app pode usar do seu Drive?' }), dialog => dialog.getByRole('button', { name: 'Salvar' }).click())
  if (PERFIL === 'celular') {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (9_000_000 / 8) | 0, uploadThroughput: (1_500_000 / 8) | 0 })
  }
  return page
}

async function pronta(page: Page) {
  await expect(page.getByRole('treeitem', { name: 'Pasta grande' })).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.blk-layer')).toHaveCount(0, { timeout: 120_000 })
}

async function ir(page: Page, path: string) {
  await page.goto(`${APP}${path}`)
  await pronta(page)
}

const main = (page: Page) => page.getByRole('main')

async function rodar(PERFIL: string, op: string, rodada: number, run: () => Promise<Medida>) {
  if (SO && !SO.has(op)) return
  try {
    const medida = await run()
    resultados.push({ ...medida, perfil: PERFIL, rodada })
  } catch (error) {
    falhas.push({ perfil: PERFIL, op, rodada, erro: error instanceof Error ? error.message.split('\n')[0] : String(error) })
  }
}

test.afterAll(() => {
  if (process.env.PERF_SAIDA) writeFileSync(process.env.PERF_SAIDA, JSON.stringify({ perfis: PERFIS, rodadas: RODADAS, quando: new Date().toISOString(), resultados, falhas }, null, 2))
})

for (const PERFIL of PERFIS)
test(`medidas · ${PERFIL}`, async ({ browser }) => {
  for (let r = 0; r < RODADAS; r++) {
    // abrir o app: num aparelho novo (sem nada guardado), e de novo no mesmo aparelho
    const context = await contexto(browser)
    const page = await pagina(context, PERFIL)
    await rodar(PERFIL, 'abrir-app-novo', r, () => medirAbertura(page, 'abrir-app-novo', `${APP}/`, { css: '[role="treeitem"]', text: 'Pasta grande' }, API))
    // with --so leaving the opening out, the app still opens: the other operations start from it
    if (page.url() === 'about:blank') await page.goto(`${APP}/`)
    await pronta(page)
    await rodar(PERFIL, 'abrir-app-cache', r, () => medirAbertura(page, 'abrir-app-cache', `${APP}/`, { css: '[role="treeitem"]', text: 'Pasta grande' }, API))
    await pronta(page)

    // trocar de tela
    await ir(page, '/')
    // the row of the folder in the Biblioteca's list: "Reuniões" also shows in "Últimas coisas feitas" once a round changed a note in it,
    // and a text anywhere in main was already there before the click (26/11: 4 of 5 rounds lost)
    await rodar(PERFIL, 'tela-biblioteca', r, () => medir(page, 'tela-biblioteca', page.getByRole('treeitem', { name: 'Biblioteca' }), { css: 'main tr[aria-label="Reuniões"]' }, API))
    await rodar(PERFIL, 'tela-gravacoes', r, () => medir(page, 'tela-gravacoes', page.getByRole('button', { name: /^Gravações/ }), { css: 'main', text: 'Reunião de teste 003' }, API))
    await rodar(PERFIL, 'tela-geracoes', r, () => medir(page, 'tela-geracoes', page.getByRole('button', { name: /^Gerações/ }), { css: 'main', text: 'Gerando' }, API))
    await rodar(PERFIL, 'tela-idiomas', r, () => medir(page, 'tela-idiomas', page.getByRole('button', { name: /^Idiomas/ }), { css: 'main', text: 'Idiomas' }, API))
    await rodar(PERFIL, 'tela-config', r, async () => {
      const medida = await medir(page, 'tela-config', page.getByRole('button', { name: 'Configurações' }).first(), { css: '[role="dialog"]', text: 'Armazenamento' }, API)
      return medida
    })
    await rodar(PERFIL, 'abrir-locais', r, () => medir(page, 'abrir-locais', page.getByRole('dialog').getByRole('tab', { name: /Armazenamento/ }).or(page.getByRole('dialog').getByRole('button', { name: /^Armazenamento/ })).first(), { css: '[role="dialog"]', text: 'Pasta grande' }, API))
    await page.keyboard.press('Escape')

    // abrir uma pasta com 1.000 notas, e notas dela
    await ir(page, '/')
    await rodar(PERFIL, 'abrir-pasta', r, () => medir(page, 'abrir-pasta', page.getByRole('treeitem', { name: 'Pasta grande' }), { js: `location.pathname.endsWith('/seed-folder-001') && Boolean(document.querySelector('main tr[aria-label="Nota de estudo 0001"]'))` }, API))
    await ir(page, '/biblioteca/seed-folder-001')
    const texto = `Nota de estudo ${pad(10 + r, 4)}`
    await rodar(PERFIL, 'abrir-nota-texto', r, () => medir(page, 'abrir-nota-texto', main(page).getByText(texto, { exact: true }).first(), { js: `(() => { const viewer = document.querySelector('[data-testid="github-viewer"]'); return Boolean(viewer?.shadowRoot && (viewer.shadowRoot.textContent ?? '').includes('Parte 8')) })()` }, API))
    await ir(page, '/biblioteca/seed-folder-002')
    const reuniao = `Reunião de teste ${pad(2 + r, 3)}`
    await rodar(PERFIL, 'abrir-nota-midia', r, () => medir(page, 'abrir-nota-midia', main(page).getByText(reuniao, { exact: true }).first(), { css: 'body', text: '00:18' }, API))

    // buscar, do fim da digitação ao resultado
    await ir(page, '/biblioteca/seed-folder-001')
    const busca = `Nota de estudo ${pad(700 + r, 4)}`
    await rodar(PERFIL, 'buscar', r, () =>
      medirDigitando(page, 'buscar', main(page).getByPlaceholder(/Buscar em nomes/), busca, { js: `(() => { const rows = [...document.querySelectorAll('main tr[aria-label]')]; return rows.length > 0 && rows.every(row => row.getAttribute('aria-label') === '${busca}') })()` }, API),
    )

    // mudanças de um item
    await ir(page, '/')
    await page.getByRole('treeitem', { name: 'Biblioteca' }).click()
    await main(page).getByRole('button', { name: 'Nova pasta' }).first().click()
    const pasta = `Pasta medida ${PERFIL} ${r}`
    await page.getByRole('dialog', { name: 'Nova pasta' }).getByLabel('Nome', { exact: true }).fill(pasta)
    await rodar(PERFIL, 'criar', r, () => medir(page, 'criar', page.getByRole('button', { name: 'Criar pasta' }), { css: '[role="treeitem"]', text: pasta }, API))

    await ir(page, '/biblioteca/seed-folder-001')
    // the folder draws its first 120 rows (spec 007, T042): the notes changed here are among them
    const renomear = `Nota de estudo ${pad(20 + r, 4)}`
    // the new name keeps the note in its place in the list (by name): a name sorted after the 120th row would not be drawn
    const novoNome = `${renomear} renomeada ${PERFIL}`
    await rodar(PERFIL, 'renomear', r, async () => {
      await main(page).getByRole('button', { name: `Opções de ${renomear}` }).click()
      await page.getByRole('button', { name: 'Renomear', exact: true }).click()
      await page.getByRole('dialog', { name: 'Renomear arquivo' }).getByLabel('Nome', { exact: true }).fill(novoNome)
      return medir(page, 'renomear', page.getByRole('dialog', { name: 'Renomear arquivo' }).getByRole('button', { name: 'Salvar' }), { css: 'main', text: novoNome }, API)
    })

    const mover = `Nota de estudo ${pad(40 + r, 4)}`
    await rodar(PERFIL, 'mover', r, async () => {
      await main(page).getByRole('button', { name: `Opções de ${mover}` }).click()
      await page.getByRole('button', { name: 'Mover', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Mover 1 item' })
      await dialog.getByRole('treeitem', { name: /Reuniões/ }).first().click()
      return medir(page, 'mover', dialog.getByRole('button', { name: 'Mover', exact: true }), { css: 'main', text: mover, gone: true }, API)
    })

    const apagar = `Nota de estudo ${pad(60 + r, 4)}`
    await rodar(PERFIL, 'apagar', r, async () => {
      await main(page).getByRole('button', { name: `Opções de ${apagar}` }).click()
      return medir(page, 'apagar', page.getByRole('button', { name: 'Apagar', exact: true }), { css: 'main', text: apagar, gone: true }, API)
    })

    await rodar(PERFIL, 'restaurar', r, async () => {
      await page.getByRole('button', { name: /^Lixeira/ }).click()
      const linha = main(page).getByText(apagar, { exact: true }).first()
      await expect(linha).toBeVisible()
      const botao = main(page).locator('*', { has: page.getByText(apagar, { exact: true }) }).getByRole('button', { name: 'Restaurar' }).last()
      return medir(page, 'restaurar', botao, { css: 'main', text: apagar, gone: true }, API)
    })

    // a mídia de 1 hora: tocar e pular para um minuto
    await ir(page, '/arquivo/seed-rec-001')
    await rodar(PERFIL, 'tocar-midia', r, () =>
      medir(page, 'tocar-midia', page.getByRole('button', { name: 'Tocar', exact: true }).first(), { js: `(() => { const m = document.querySelector('audio, video'); return !!m && !m.paused && m.readyState >= 3 && m.currentTime > 0 })()` }, API),
    )
    const minuto = `00:${pad(30 + r * 6, 2)}`
    await rodar(PERFIL, 'pular-minuto', r, () =>
      medir(page, 'pular-minuto', page.getByRole('button', { name: `Tocar a partir de ${minuto}` }).first(), { js: `(() => { const m = document.querySelector('audio, video'); return !!m && !m.seeking && Math.abs(m.currentTime - ${30 + r * 6}) < 1.5 && m.readyState >= 3 })()` }, API),
    )

    // uma mudança num aparelho aparecendo no outro, sem recarregar
    await rodar(PERFIL, 'mudanca-outro-aparelho', r, async () => {
      const other = await contexto(browser)
      const outra = await pagina(other, PERFIL)
      await ir(outra, '/biblioteca/seed-folder-001')
      await ir(page, '/biblioteca/seed-folder-001')
      const nota = `Nota de estudo ${pad(80 + r, 4)}`
      const nome = `Vista no outro ${PERFIL} ${r}`
      await main(page).getByRole('button', { name: `Opções de ${nota}` }).click()
      await page.getByRole('button', { name: 'Renomear', exact: true }).click()
      await page.getByRole('dialog', { name: 'Renomear arquivo' }).getByLabel('Nome', { exact: true }).fill(nome)
      // a long folder draws its first rows only, and the new name sorts to the end: the change has arrived when the old name leaves
      // the other device's list (or the new one shows); 2 minutes without it is a failure, not a hang
      await expect(main(outra).getByText(nota, { exact: true }).first()).toBeAttached()
      const chegou = outra.evaluate(
        async ([nota, nome]) => {
          const desde = Date.now()
          for (;;) {
            const texto = document.querySelector('main')?.textContent ?? ''
            if (!texto.includes(nota) || texto.includes(nome)) return Date.now()
            if (Date.now() - desde > 120_000) throw new Error(`a mudança não chegou ao outro aparelho em 2 minutos`)
            await new Promise(resolve => setTimeout(resolve, 20))
          }
        },
        [nota, nome] as const,
      )
      const clicou = await page.evaluate(() => Date.now())
      await page.getByRole('dialog', { name: 'Renomear arquivo' }).getByRole('button', { name: 'Salvar' }).click()
      const ms = await chegou.then(at => at - clicou).finally(() => other.close())
      return { op: 'mudanca-outro-aparelho', ms, rede: 0, servidor: 0, aparelho: 0, pedidos: 0 }
    })

    await context.close()
  }
})
