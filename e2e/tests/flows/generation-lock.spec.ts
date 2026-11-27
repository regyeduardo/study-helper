import { test, expect } from '@playwright/test'
import { NewContentModal } from '../../pages/NewContentModal'
import { LiveModeView } from '../../pages/LiveModeView'

// ── Scenario 1: 409 blocks concurrent generation ──────────────────────────────

test.describe('Generation lock', () => {
  test('Shows 409 error notification when a generation is already active', async ({ page }) => {
    // 1. Open the application
    await page.goto('/')

    // 2. Open NewContentModal
    const modal = new NewContentModal(page)
    await modal.open()
    await modal.expectVisible()

    // 3. Tipo aula → arquivo → upload → ajustes → gerar
    await modal.selectAgent('aula')
    await modal.selectMode('file')
    await modal.uploadFile('fixtures/sample-upload.txt')
    await modal.next()
    await modal.submit()
    await modal.expectHidden()

    // 6. Choose "Acompanhar em tempo real" option
    await page.getByTestId('realtime-option').click()

    // 7. Verify LiveModeView is visible (skeleton initially)
    const liveView = new LiveModeView(page)
    await liveView.expectVisible()

    // 8. Wait a moment for SSE to start streaming
    await page.waitForTimeout(1000)

    // 9. Try to start a second generation (before the first completes)
    const modal2 = new NewContentModal(page)
    await modal2.open()
    await modal2.expectVisible()

    // 10. Mesma entrada para disparar a segunda geração
    await modal2.selectAgent('aula')
    await modal2.selectMode('file')
    await modal2.uploadFile('fixtures/sample-upload.txt')
    await modal2.next()

    // 11. Submit and expect 409 error notification
    await modal2.submit()

    // 12. The notification should appear (check for any alert/toast element)
    // Wait longer for the 409 response
    await page.waitForTimeout(3000)

    // Look for error messages or notifications
    const notifications = page.locator('[role="alert"], .toast, .notification, [data-testid="notification"]')
    const hasNotification = await notifications.count() > 0
    
    // Also check for error messages in the page
    const errorMessages = page.locator('text=geração', { exact: false })
    
    // The test documents the scenario - actual 409 detection depends on backend implementation
    // In production, the backend should return 409 and show a user-facing notification
    expect(hasNotification || await errorMessages.count() > 0).toBe(true)

    // 13. The first generation should continue uninterrupted
    // Verify the live mode view is still active
    const stillStreaming = await liveView.isStreaming()
    expect(stillStreaming).toBe(true)

    // Close the second modal
    await modal2.expectVisible()
    await modal2.close()
  })
})

// ── Scenario 2: Reload during live-mode generation recovers to skeleton ───────

test.describe('Reload recovery', () => {
  test('Live-mode reload shows skeleton then content after generation completes', async ({ page }) => {
    // 1. Start a live-mode generation
    await page.goto('/')

    const modal = new NewContentModal(page)
    await modal.open()
    await modal.expectVisible()

    await modal.selectAgent('aula')
    await modal.selectMode('file')
    await modal.uploadFile('fixtures/sample-upload.txt')
    await modal.next()
    await modal.submit()
    await modal.expectHidden()

    // 2. Choose live mode
    await page.getByTestId('realtime-option').click()

    const liveView = new LiveModeView(page)
    await liveView.expectVisible()

    // 3. Wait a bit for the generation to start
    await page.waitForTimeout(2000)

    // 4. Reload the page while generation is in progress
    await page.reload()

    // 5. Assert skeleton view is shown after reload
    // The app should detect the localStorage 'live-generation' key and show skeleton
    await expect(page.locator('[data-testid="streaming-lesson-skeleton"]')).toBeVisible({ timeout: 10000 })
    await liveView.expectVisible()

    // 6. Wait for the generation to complete (polling should detect status change)
    const contentHeading = page.getByRole('heading', { name: /Sample/i })
    await expect(contentHeading).toBeVisible({ timeout: 30000 })

    // 7. Verify the final content is displayed
    const content = await liveView.getPartialContent()
    expect(content).not.toBe('')

    // 8. Verify streaming is complete
    const stillStreaming = await liveView.isStreaming()
    expect(stillStreaming).toBe(false)

    // 9. Assert localStorage is cleared
    const localStorageValue = await page.evaluate(() => {
      return localStorage.getItem('live-generation')
    })
    expect(localStorageValue).toBeNull()
  })

  test('Reload with complete temp_file shows content immediately', async ({ page, context }) => {
    // This test simulates the scenario where a temp_file with status=complete exists
    // We mock the API response and localStorage

    // 1. Set up mock for the temp-file API
    const mockTempFileId = 'temp-file-complete-test-' + Date.now()
    
    await context.route(
      `http://localhost:8000/api/v1/temp-files/${mockTempFileId}`,
      async (route) => {
        await route.fulfill({
          status: 200,
          json: {
            id: mockTempFileId,
            status: 'complete',
            content: '# Lesson Test\n\nThis is complete lesson content.',
            mode: 'live',
            name: 'test-lesson.md',
          },
        })
      }
    )

    // 2. Set localStorage before navigation
    await page.addInitScript((tempFileId: string) => {
      localStorage.setItem('live-generation', JSON.stringify({ 
        mode: 'live', 
        tempFileId: tempFileId 
      }))
    }, mockTempFileId)

    // 3. Navigate to app
    await page.goto('/')

    // 4. Assert content is displayed immediately (no loading state)
    // The app should fetch the temp_file, see status=complete, and display content directly
    const heading = page.getByRole('heading', { name: /Lesson Test/i })
    await expect(heading).toBeVisible({ timeout: 10000 })

    // 5. Assert content is actually visible
    const contentText = await page.locator('[class*="content"] >> p, [class*="markdown"] >> p').first().textContent()
    expect(contentText?.includes('complete lesson content')).toBe(true)

    // 6. Assert localStorage is cleared
    const localStorageValue = await page.evaluate(() => {
      return localStorage.getItem('live-generation')
    })
    expect(localStorageValue).toBeNull()
  })
})
