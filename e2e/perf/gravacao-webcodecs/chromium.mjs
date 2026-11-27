// runs a page of this folder in Chromium (headless), as server.mjs does for Waterfox: POSTs to /result, /video and /file
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from '../../node_modules/@playwright/test/index.mjs'
const dir = path.dirname(new URL(import.meta.url).pathname)
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage()
let done = false
await page.route('http://localhost:9/**', async route => {
  const request = route.request()
  const url = new URL(request.url())
  if (request.method() === 'POST') {
    const body = request.postDataBuffer() ?? Buffer.alloc(0)
    if (url.pathname === '/file') writeFileSync(path.join(dir, url.searchParams.get('name')), body)
    else if (url.pathname === '/video') writeFileSync(path.join(dir, url.searchParams.get('name') + '.webm'), body)
    else { console.log('result', body.toString()); if (body.toString().includes('"done"') || body.toString().includes('"error"')) done = true }
    return route.fulfill({ body: 'ok' })
  }
  const name = url.pathname.slice(1)
  route.fulfill({ body: readFileSync(path.join(dir, name)), contentType: name.endsWith('.js') ? 'text/javascript' : 'text/html' })
})
await page.goto('http://localhost:9/' + process.argv[2])
for (let i = 0; i < 1200 && !done; i++) await new Promise(r => setTimeout(r, 100))
await browser.close()
