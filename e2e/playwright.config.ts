import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/',
  outputDir: 'test-results/',

  /* Sequential execution to avoid race conditions */
  workers: 1,

  /* Base URL for the application under test */
  baseURL: 'http://localhost:8080',

  /* Global setup */
  globalSetup: './global-setup',

  /* Retry configuration */
  retries: process.env.CI ? 1 : 0,

  /* Reporters */
  reporter: [
    ['html'],
    ['list'],
  ],

  use: {
    /* Capture screenshot automatically when a test fails */
    screenshot: 'only-on-failure',
  },

  /* Only Chromium for now */
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
      },
    },
  ],
})
