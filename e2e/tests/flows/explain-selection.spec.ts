import { expect } from '@playwright/test'
import { test } from '../../fixtures/api-helpers'
import { FileManagerModal } from '../../pages/FileManagerModal'

/**
 * Fluxo E2E: gerar explicação a partir de um trecho selecionado.
 *
 * 1. Cria pasta + aula via API
 * 2. Abre a aula pelo gerenciador de arquivos
 * 3. Seleciona um trecho e abre o menu de contexto
 * 4. Dispara "Gerar explicação" e confirma no formulário de prompt
 * 5. Verifica que o temp file gerado guarda o arquivo de origem e o trecho
 */
test.describe('Flow: explicação a partir de seleção', () => {
  let folderId: string
  let fileId: string

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('http://localhost:8080/')
  })

  test.afterEach(async ({ apiHelpers }) => {
    if (fileId) await apiHelpers.deleteFile(fileId).catch(() => {})
    if (folderId) await apiHelpers.deleteFolder(folderId).catch(() => {})
  })

  test('seleção → menu de contexto → explicação com rastreio de origem', async ({ page, apiHelpers }) => {
    const folder = await apiHelpers.createFolder('Explicações')
    folderId = folder.id

    const file = await apiHelpers.createFile({
      name: 'Aula de Redes',
      folderId: folder.id,
      content: '# Aula de Redes\n\nO protocolo TCP garante entrega ordenada dos pacotes.\n',
      file_type: 'class',
    })
    fileId = file.id

    const fileManager = new FileManagerModal(page)
    await fileManager.open()
    await fileManager.openFolder('Explicações')
    await fileManager.selectFile('Aula de Redes')

    const paragraph = page.getByText('O protocolo TCP garante entrega ordenada dos pacotes.')
    await expect(paragraph).toBeVisible()

    await paragraph.evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })

    await paragraph.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Gerar explicação' }).click()

    await expect(page.getByTestId('selection-excerpt')).toContainText('protocolo TCP')
    await page.getByTestId('explain-selection-submit').click()

    await expect
      .poll(async () => {
        const response = await fetch('http://localhost:8000/api/v1/temp-files')
        const tempFiles = (await response.json()) as Array<{
          type: string
          parent_file_id: string | null
          source_excerpt: string | null
          status: string
        }>
        return tempFiles.find((item) => item.parent_file_id === fileId) ?? null
      }, { timeout: 60_000 })
      .not.toBeNull()

    const response = await fetch('http://localhost:8000/api/v1/temp-files')
    const tempFiles = (await response.json()) as Array<{
      id: string
      type: string
      parent_file_id: string | null
      source_excerpt: string | null
    }>
    const generated = tempFiles.find((item) => item.parent_file_id === fileId)!

    expect(generated.type).toBe('explanation')
    expect(generated.source_excerpt).toContain('protocolo TCP')

    await fetch(`http://localhost:8000/api/v1/temp-files/${generated.id}`, { method: 'DELETE' })
  })
})
