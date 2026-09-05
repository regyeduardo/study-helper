import { test, expect } from '@playwright/test'
import { NewContentModal } from '../../pages/NewContentModal'

test.describe('NewContentModal — passos', () => {
  let modal: NewContentModal

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('http://localhost:8080/')
    modal = new NewContentModal(page)
    await modal.open()
    await modal.expectVisible()
  })

  test('1. abre no passo 1 com os três tipos de conteúdo', async ({ page }) => {
    await modal.expectStep(1, 3)
    await expect(page.getByTestId('agent-card-aula')).toBeVisible()
    await expect(page.getByTestId('agent-card-explicacao')).toBeVisible()
    await expect(page.getByTestId('agent-card-leitura')).toBeVisible()
  })

  test('2. fecha pelo X e pelo Cancelar', async ({ page }) => {
    await modal.close()
    await modal.expectHidden()

    await modal.open()
    await page.getByTestId('modal-cancel').click()
    await modal.expectHidden()
  })

  test('3. escolher o tipo avança para a origem', async () => {
    await modal.selectAgent('aula')
    await modal.expectStep(2, 3)
  })

  test('4. leitura tem só dois passos', async ({ page }) => {
    await modal.selectAgent('leitura')
    await modal.expectStep(2, 2)
    await expect(page.getByTestId('step-submit')).toBeVisible()
  })

  test('5. origem link mostra o campo de URL', async ({ page }) => {
    await modal.selectAgent('aula')
    await modal.selectMode('url')

    await expect(page.getByPlaceholder(/https?:\/\//i)).toBeVisible()
    await expect(page.getByText(/clique para selecionar/i)).not.toBeVisible()
  })

  test('6. origem arquivo mostra a área de upload', async ({ page }) => {
    await modal.selectAgent('aula')
    await modal.selectMode('url')
    await modal.selectMode('file')

    await expect(page.getByText(/clique para selecionar/i)).toBeVisible()
    await expect(page.getByPlaceholder(/https?:\/\//i)).not.toBeVisible()
  })

  test('7. explicação abre no modo tema', async ({ page }) => {
    await modal.selectAgent('explicacao')
    await expect(page.getByLabel(/assunto ou dúvida/i)).toBeVisible()
  })

  test('8. Continuar fica bloqueado sem entrada e libera ao preencher', async ({ page }) => {
    await modal.selectAgent('explicacao')
    await modal.expectNextDisabled()

    await modal.fillTopic('O que é React?')
    await expect(page.getByTestId('step-next')).toBeEnabled()
  })

  test('9. URL inválida mostra erro e some ao corrigir', async ({ page }) => {
    await modal.selectAgent('aula')
    await modal.selectMode('url')
    const urlInput = page.getByPlaceholder(/https?:\/\//i)

    await urlInput.fill('not-a-url')
    await expect(page.getByText(/insira uma URL válida/i)).toBeVisible()

    await urlInput.fill('https://youtube.com/watch?v=abc123')
    await expect(page.getByText(/insira uma URL válida/i)).not.toBeVisible()
  })

  test('10. passo de ajustes traz tamanho só para aula', async ({ page }) => {
    await modal.selectAgent('aula')
    await modal.selectMode('url')
    await modal.fillUrl('https://exemplo.com/artigo')
    await modal.next()

    await modal.expectStep(3, 3)
    await expect(page.getByTestId('lesson-size-medium')).toBeVisible()
    await expect(page.getByLabel(/instruções adicionais/i)).toBeVisible()
  })

  test('11. explicação não mostra o seletor de tamanho', async ({ page }) => {
    await modal.selectAgent('explicacao')
    await modal.fillTopic('O que é React?')
    await modal.next()

    await modal.expectStep(3, 3)
    await expect(page.getByTestId('lesson-size-medium')).toHaveCount(0)
  })

  test('12. Voltar retorna ao passo anterior mantendo o tipo', async ({ page }) => {
    await modal.selectAgent('explicacao')
    await modal.fillTopic('O que é React?')
    await modal.next()

    await modal.back()
    await modal.expectStep(2, 3)
    await expect(page.getByLabel(/assunto ou dúvida/i)).toHaveValue('O que é React?')
  })

  test('13. o resumo do topo volta para a escolha do tipo', async ({ page }) => {
    await modal.selectAgent('aula')
    await page.getByTestId('summary-chip-agent').click()

    await modal.expectStep(1, 3)
  })

  test('14. Escape fecha o modal', async ({ page }) => {
    await page.keyboard.press('Escape')
    await modal.expectHidden()
  })
})
