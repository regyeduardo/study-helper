import { test, expect } from '@playwright/test'

/**
 * End-to-end tests for Mermaid diagram zoom controls.
 *
 * Tests that the react-zoom-pan-pinch TransformWrapper overlay buttons
 * (+, –, reset) are visible, increase scale, and reset correctly.
 *
 * @see .issues/20260516-003-generation-lock-diagram-nav-mermaid-fix-and-ux-improvements/015-e2e-diagram-zoom-controls.md
 */

const BASE_URL = 'http://localhost:8080'

test.describe('Diagram zoom controls', () => {
  const MINUS_LABEL = '\u2013' // En-dash

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(BASE_URL)
  })

  // ── Setup: Create file with mermaid diagram and open it ───────────────────

  async function setupAndOpenDiagram(page: any): Promise<string> {
    const fileName = `diagram-zoom-${Date.now()}.md`
    const mermaidCode = `
\`\`\`mermaid
graph TD
  A[Test] --> B[Diagram]
\`\`\`
`

    // Create file via API - need absolute URL for cross-origin fetch
    const createRes = await page.goto(`${BASE_URL}/api/v1/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: fileName,
        content: mermaidCode,
        type: 'class',
      }),
    })

    // Try alternative: use evaluate to fetch from page context
    const result = await page.evaluate(async (data) => {
      const res = await fetch('/api/v1/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      return res.json()
    }, {
      name: fileName,
      content: mermaidCode,
      type: 'class',
    })
    const fileId = result.id

    // Wait a bit for the API to process
    await page.waitForTimeout(500)

    // Open File Manager via dock
    await page.getByTestId('file-manager-trigger').click()
    
    // Wait for modal to be visible
    await expect(page.getByTestId('file-manager-modal')).toBeVisible({ timeout: 10000 })

    // Wait a bit for the file tree to load
    await page.waitForTimeout(1000)

    // Navigate to root folder if needed
    const rootFolder = page.locator('[data-testid="folder-row"]').filter({
      hasText: 'Raiz'
    }).first()
    if (await rootFolder.isVisible()) {
      await rootFolder.click()
      await page.waitForTimeout(1000)
    }

    // Click on the file in the file manager
    await page
      .locator('[data-testid="file-row"]')
      .filter({ hasText: fileName })
      .first()
      .click({ timeout: 10000 })

    // Wait for file manager to close
    await expect(page.getByTestId('file-manager-modal')).not.toBeVisible({ timeout: 10000 })

    // Wait for the diagram to render
    await page.waitForTimeout(3000)

    return fileId
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  async function cleanupDiagram(page: any) {
    try {
      const filesResponse = await page.evaluate(async () => {
        const res = await fetch('/api/v1/files')
        return res.json()
      })
      // Find and delete test files
      const testFiles = (filesResponse || []).filter((f: any) => 
        f.name && f.name.startsWith('diagram-zoom-')
      )
      for (const file of testFiles) {
        await page.evaluate((id) => {
          fetch('/api/v1/files/' + id, { method: 'DELETE' })
        }, file.id)
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  test.afterEach(async ({ page }) => {
    await cleanupDiagram(page)
  })

  // ── Test 1: zoom buttons are visible on a rendered diagram ─────────────────

  test('zoom buttons are visible on a rendered diagram', async ({ page }) => {
    await setupAndOpenDiagram(page)

    // Wait for the mermaid container to have an SVG (diagram rendered)
    await expect(
      page.locator('.mermaid-container svg').first(),
    ).toBeVisible({ timeout: 15_000 })

    // Wait for the TransformWrapper to be ready
    await expect(
      page.locator('.wrapper').first(),
    ).toBeVisible({ timeout: 15_000 })

    // Wait a bit for the zoom controls to appear
    await page.waitForTimeout(500)

    // Assert that the zoom overlay buttons are visible inside the TransformWrapper
    const plusBtn = page.locator('.wrapper').first().getByRole('button', { name: '+' })
    const minusBtn = page.locator('.wrapper').first().getByRole('button', { name: MINUS_LABEL })
    const resetBtn = page.locator('.wrapper').first().getByRole('button', { name: 'reset' })

    await expect(plusBtn).toBeVisible()
    await expect(minusBtn).toBeVisible()
    await expect(resetBtn).toBeVisible()
  })

  // ── Test 2: zoom-in button increases SVG transform scale ───────────────────

  test('zoom-in button increases SVG transform scale', async ({ page }) => {
    await setupAndOpenDiagram(page)

    // Get the initial transform scale (should be 1 / no transform)
    const transformComponent = page.locator('.transform-component').first()
    const initialTransform = await transformComponent.evaluate(
      (el) => el.style.transform,
    )
    expect(initialTransform).toMatch(/scale\(1|none|translate/)

    // Click the zoom-in button multiple times to ensure scale increases
    const plusBtn = page.locator('.wrapper').first().getByRole('button', { name: '+' })
    await plusBtn.click()
    await plusBtn.click()
    await plusBtn.click()

    // Wait for the transform to update
    await page.waitForTimeout(500)

    // Inspect the CSS transform — scale should now be > 1
    const newTransform = await transformComponent.evaluate(
      (el) => el.style.transform,
    )

    // Extract the scale value from the transform string
    // e.g. "scale(1.5, 1.5)" or "matrix(1.5, 0, 0, 1.5, 0, 0)"
    const scaleMatch = newTransform.match(/scale\(([0-9.]+),\s*([0-9.]+)\)/)
    const matrixMatch = newTransform.match(
      /matrix\([^,]+,[^,]+,[^,]+,\s*([^,]+),[^,]+,[^,]+\)/,
    )

    let scale: number
    if (scaleMatch) {
      scale = parseFloat(scaleMatch[1])
    } else if (matrixMatch) {
      // In matrix notation, scale = a = d (diagonal elements)
      scale = parseFloat(matrixMatch[1])
    } else {
      // Fallback: check that transform is different from initial (empty means scale=1)
      expect(newTransform).not.toBe(initialTransform)
      return
    }

    expect(scale).toBeGreaterThan(1)
  })

  // ── Test 3: reset button restores default transform ────────────────────────

  test('reset button restores default transform', async ({ page }) => {
    await setupAndOpenDiagram(page)

    const transformComponent = page.locator('.transform-component').first()

    // Zoom in first
    const plusBtn = page.locator('.wrapper').first().getByRole('button', { name: '+' })
    await plusBtn.click()
    await plusBtn.click()
    await plusBtn.click()
    await page.waitForTimeout(500)

    // Verify that transform is no longer identity (scale != 1)
    const afterZoom = await transformComponent.evaluate(
      (el) => el.style.transform,
    )
    const scaleAfterZoom = afterZoom.match(
      /scale\(([0-9.]+),\s*([0-9.]+)\)/,
    )?.[1]
    const matrixAfterZoom = afterZoom.match(
      /matrix\([^,]+,[^,]+,[^,]+,\s*([^,]+),[^,]+,[^,]+\)/,
    )?.[1]

    const scaleValue = scaleAfterZoom ? parseFloat(scaleAfterZoom) : matrixAfterZoom ? parseFloat(matrixAfterZoom) : 0
    expect(scaleValue).toBeGreaterThan(1)

    // Now click the reset button
    const resetBtn = page.locator('.wrapper').first().getByRole('button', { name: 'reset' })
    await resetBtn.click()

    // Wait for the transform to update
    await page.waitForTimeout(500)

    // Verify that scale returned to 1 (identity transform)
    const afterReset = await transformComponent.evaluate(
      (el) => el.style.transform,
    )

    const scaleAfterReset = afterReset.match(
      /scale\(([0-9.]+),\s*([0-9.]+)\)/,
    )?.[1]
    const matrixAfterReset = afterReset.match(
      /matrix\([^,]+,[^,]+,[^,]+,\s*([^,]+),[^,]+,[^,]+\)/,
    )?.[1]

    if (scaleAfterReset) {
      expect(parseFloat(scaleAfterReset)).toBeCloseTo(1, 1)
    } else if (matrixAfterReset) {
      // Matrix form: scale factor = a (first diagonal element)
      expect(parseFloat(matrixAfterReset)).toBeCloseTo(1, 1)
    } else {
      // Empty string or "none" — both indicate identity transform
      expect(afterReset).toMatch(/(none|^$)/)
    }
  })
})
