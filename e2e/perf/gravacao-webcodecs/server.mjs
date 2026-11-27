import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const dir = path.dirname(new URL(import.meta.url).pathname)
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (req.method === 'POST') {
    const parts = []
    req.on('data', d => parts.push(d))
    req.on('end', () => {
      const body = Buffer.concat(parts)
      if (url.pathname === '/file') { writeFileSync(path.join(dir, url.searchParams.get('name')), body) }
      else if (url.pathname === '/video') { writeFileSync(path.join(dir, url.searchParams.get('name') + '.webm'), body); console.log('video', url.searchParams.get('name'), body.length) }
      else console.log('result', body.toString())
      res.end('ok')
    })
    return
  }
  const name = url.pathname.slice(1) || 'ff.html'
  let data; try { data = readFileSync(path.join(dir, name)) } catch { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(data)
}).listen(Number(process.env.PORT || 9411), '127.0.0.1')
