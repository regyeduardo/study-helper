#!/usr/bin/env node
// The measure of the light recording (spec 007, história 3, T096/T097, research R12), from the repository root:
//   node e2e/perf/gravacao.mjs [--segundos 120] [--variantes A,B,C,D,E,F] [--cena slides|movimento|documento|apresentacao] [--saida specs/007-desempenho-gerar-compartilhar/medidas/gravacao.json]
// With --tela-do-app <frame-grab.ts> (T173) the scene is the screen handed to the app's own ScreenCanvas from that file, which decides the
// frames (variant O, the optimized recording, at --fps 30); give the file of before and the one of now to compare the two.
// It records, in Chromium, a screen made in a canvas (a slide of text that changes every 20 s, the mouse walking, a line being typed and
// a small camera tile always moving; or, in the scene "movimento", four camera tiles filling the screen) at 5 frames per second, the way the app records the screen (ScreenCanvas), with a tone as the
// audio (Opus 32 kb/s), once per variant of src/lib/recording/variants.ts. For each one: the size per hour, whether the whole video
// decodes, how many key frames, and how close the text of the slide stays to the original (SSIM of the text area; 1 is identical).
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'
import { buildSync } from 'esbuild'

import { OPTIMIZED, recorderOptions, VARIANTS } from '../../src/lib/recording/variants.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const option = (name, fallback) => {
  const at = process.argv.indexOf(name)
  return at > 0 ? process.argv[at + 1] : fallback
}
const seconds = Number(option('--segundos', '120'))
const ids = option('--variantes', Object.keys(VARIANTS).join(',')).split(',')

const scene = option('--cena', 'slides')
const fps = Number(option('--fps', '5'))
// candidates of the optimized recording (research R17), measured before one goes into variants.ts: gated = a frame only when the
// picture changed, the second after a change (the encoder settles the picture) and one per second; hint = the track's contentHint
const VP9 = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
const AV1 = ['video/webm;codecs=av01,opus', 'video/webm;codecs=av1,opus', ...VP9]
const CANDIDATES = {
  G: { label: 'VP9 até 300 kb/s a 30 q/s, detalhe', videoBitsPerSecond: { 5: 300_000, 30: 300_000 }, videoMimes: VP9, contentHint: 'detail' },
  OV: { label: 'VP9 até 250 kb/s, só quando muda, texto', videoBitsPerSecond: { 5: 250_000, 30: 250_000 }, videoMimes: VP9, contentHint: 'text', gated: true },
  OA: { label: 'AV1 até 250 kb/s, só quando muda, texto', videoBitsPerSecond: { 5: 250_000, 30: 250_000 }, videoMimes: AV1, contentHint: 'text', gated: true },
  OA2: { label: 'AV1 até 200 kb/s, só quando muda, texto', videoBitsPerSecond: { 5: 200_000, 30: 200_000 }, videoMimes: AV1, contentHint: 'text', gated: true },
  OAd: { label: 'AV1 até 250 kb/s, só quando muda, detalhe', videoBitsPerSecond: { 5: 250_000, 30: 250_000 }, videoMimes: AV1, contentHint: 'detail', gated: true },
  // a 30 q/s o Chrome põe um quadro-chave a cada 100 quadros (a cada ~3 s): pedir um a cada 2 min, para ver se ele aceita espaçar
  OVk: { label: 'VP9 até 250 kb/s, só quando muda, texto, quadro-chave a cada 2 min', videoBitsPerSecond: { 5: 250_000, 30: 250_000 }, videoMimes: VP9, contentHint: 'text', gated: true, keyFrameIntervalMs: 120_000 },
  OV30: { label: 'VP9 até 250 kb/s, só quando muda, texto, quadro-chave a cada 30 s', videoBitsPerSecond: { 5: 250_000, 30: 250_000 }, videoMimes: VP9, contentHint: 'text', gated: true, keyFrameIntervalMs: 30_000 },
  OAk: { label: 'AV1 até 250 kb/s, só quando muda, detalhe, quadro-chave a cada 2 min', videoBitsPerSecond: { 5: 250_000, 30: 250_000 }, videoMimes: AV1, contentHint: 'detail', gated: true, keyFrameIntervalMs: 120_000 },
}
const ALL = { ...VARIANTS, O: OPTIMIZED, ...Object.fromEntries(Object.entries(CANDIDATES).map(([id, v]) => [id, { id, ...v }])) }
const appScreen = option('--tela-do-app', '')
const appCode = appScreen ? buildSync({ entryPoints: [path.resolve(appScreen)], bundle: true, format: 'iife', globalName: 'TelaDoApp', write: false, logLevel: 'silent' }).outputFiles[0].text : ''
const out = option('--saida', path.join(root, `specs/007-desempenho-gerar-compartilhar/medidas/gravacao${scene === 'slides' ? '' : `-${scene}`}${fps === 5 ? '' : `-${fps}qs`}.json`))
const dir = mkdtempSync(path.join(os.tmpdir(), 'estudo-gravacao-'))
// the slide shown at the end has been still for a while: the frame compared is taken there
const CHECK_AT = Math.max(2, seconds - 3)
// the text compared: the slide's body, or the name label of the first camera (it stays still while the faces move)
const TEXT_AREA = scene === 'movimento' ? 'crop=360:44:20:480' : 'crop=1400:640:120:240'

// the page that draws the screen and records it; `options` comes from recorderOptions
async function record(page, options, hint, gated, useApp) {
  return page.evaluate(
    async ({ options, hint, seconds, checkAt, scene, fps, gated, useApp }) => {
      const canvas = document.createElement('canvas')
      canvas.width = 1920
      canvas.height = 1080
      const g = canvas.getContext('2d')
      const started = performance.now()
      const lines = n => Array.from({ length: 14 }, (_, i) => `${n}.${i + 1} Item de reunião com texto pequeno, números ${(n * 137 + i * 91) % 1000} e nomes: Ana, Bruno, Carla`)
      let typed = ''
      const names = ['Ana Ribeiro', 'Bruno Tavares', 'Carla Nunes', 'Diego Prado']
      const camera = (x, y, w, h, t, i) => {
        const gradient = g.createRadialGradient(x + w / 2 + Math.sin(t * 2 + i) * w * 0.15, y + h / 2 + Math.cos(t * 1.3 + i) * h * 0.12, 10, x + w / 2, y + h / 2, w * 0.6)
        gradient.addColorStop(0, '#f3c6a5')
        gradient.addColorStop(0.5, '#8a5a44')
        gradient.addColorStop(1, '#1e293b')
        g.fillStyle = gradient
        g.fillRect(x, y, w, h)
        // the sensor noise of a webcam: what makes real video expensive to encode
        for (let n = 0; n < 220; n++) {
          g.fillStyle = `rgba(${(n * 37 + i * 50) % 255},${(n * 91) % 255},${(n * 53) % 255},0.18)`
          g.fillRect(x + Math.random() * w, y + Math.random() * h, 6, 6)
        }
        g.fillStyle = 'rgba(15,23,42,.75)'
        g.fillRect(x + 20, y + h - 60, 360, 44)
        g.fillStyle = '#fff'
        g.font = '24px sans-serif'
        g.fillText(names[i], x + 32, y + h - 30)
      }
      let shown = ''
      // force: paint the same picture again (the canvas only hands a frame when it was painted since the last one)
      const draw = (force = false) => {
        const t = (performance.now() - started) / 1000
        if (scene === 'documento') {
          // a document being read: still, scrolled every 15 s, with the mouse moving for 1 s after each scroll; no camera
          const page = Math.floor(t / 15)
          const mouse = t % 15 < 1
          const state = `${page}:${mouse ? Math.floor(t * fps) : ''}`
          if (state === shown && !force) return false
          const changed = state !== shown
          shown = state
          g.fillStyle = '#fff'
          g.fillRect(0, 0, 1920, 1080)
          g.fillStyle = '#1f2937'
          g.font = 'bold 56px sans-serif'
          g.fillText(`Documento, página ${page + 1}`, 120, 160)
          g.font = '28px sans-serif'
          lines(page + 1).forEach((line, i) => g.fillText(line, 140, 280 + i * 42))
          if (mouse) {
            g.beginPath()
            g.arc(300 + (t % 15) * 600, 900, 8, 0, Math.PI * 2)
            g.fill()
          }
          return changed
        }
        if (scene === 'apresentacao') {
          // a presentation with the camera of whoever presents in a corner (T173): the slide changes every 20 s, the camera moves all
          // the time, the mouse points for 2 s every 15 s and rests below the text otherwise; nothing is typed
          const slide = Math.floor(t / 20)
          g.fillStyle = '#fff'
          g.fillRect(0, 0, 1920, 1080)
          g.fillStyle = '#1f2937'
          g.font = 'bold 56px sans-serif'
          g.fillText(`Slide ${slide + 1}: planejamento do trimestre`, 120, 160)
          g.font = '28px sans-serif'
          lines(slide + 1).forEach((line, i) => g.fillText(line, 140, 280 + i * 42))
          camera(1560, 760, 320, 240, t, 0)
          const along = t % 15 < 2 ? (t % 15) / 2 : 1
          g.fillStyle = '#0f172a'
          g.beginPath()
          g.arc(300 + along * 900, 920, 8, 0, Math.PI * 2)
          g.fill()
          return true
        }
        if (scene === 'movimento') {
          camera(0, 0, 960, 540, t, 0)
          camera(960, 0, 960, 540, t, 1)
          camera(0, 540, 960, 540, t, 2)
          camera(960, 540, 960, 540, t, 3)
          return true
        }
        const slide = Math.floor(t / 20)
        g.fillStyle = '#fff'
        g.fillRect(0, 0, 1920, 1080)
        g.fillStyle = '#1f2937'
        g.font = 'bold 56px sans-serif'
        g.fillText(`Slide ${slide + 1}: planejamento do trimestre`, 120, 160)
        g.font = '28px sans-serif'
        lines(slide + 1).forEach((line, i) => g.fillText(line, 140, 280 + i * 42))
        // the camera tile: a face-like blob that moves all the time
        const x = 1560, y = 760
        const gradient = g.createRadialGradient(x + 160 + Math.sin(t * 2) * 40, y + 120 + Math.cos(t * 1.3) * 25, 10, x + 160, y + 120, 200)
        gradient.addColorStop(0, '#f3c6a5')
        gradient.addColorStop(1, '#334155')
        g.fillStyle = gradient
        g.fillRect(x, y, 320, 240)
        // a line being typed and the mouse
        typed = `Anotação: ${'próximo passo, '.repeat(6)}`.slice(0, Math.floor(t * 5) % 90)
        g.fillStyle = '#0f172a'
        g.font = '24px monospace'
        g.fillText(typed, 140, 960)
        g.beginPath()
        g.arc(300 + ((t * 60) % 1200), 900 - Math.abs(Math.sin(t)) * 200, 8, 0, Math.PI * 2)
        g.fill()
        return true
      }
      draw()
      // --tela-do-app: the scene is the screen handed to the app's ScreenCanvas, which decides the frames; the scene is painted only
      // when it changes, the way a real screen hands frames
      const app = useApp ? new window.TelaDoApp.ScreenCanvas(fps, true) : null
      if (app) app.show(canvas.captureStream(fps))
      const track = app ? app.track : canvas.captureStream(gated ? 0 : fps).getVideoTracks()[0]
      if (hint) track.contentHint = hint
      let changedAt = 0
      let sentAt = 0
      let sent = 0
      let looks = 0
      let lookMs = 0
      if (app) {
        const ask = track.requestFrame.bind(track)
        track.requestFrame = () => {
          sent++
          ask()
        }
        const look = Object.getPrototypeOf(app).look
        if (look) {
          app.look = (...args) => {
            const begin = performance.now()
            try {
              return look.apply(app, args)
            } finally {
              looks++
              lookMs += performance.now() - begin
            }
          }
        }
      }
      const timer = setInterval(() => {
        if (app) return void draw(false)
        // without gating the canvas is painted every tick, as the app's ScreenCanvas does (an unpainted canvas hands no frame)
        const changed = draw(!gated)
        if (!gated) return
        const now = performance.now()
        if (changed) changedAt = now
        const settling = now - changedAt < 1000
        const beat = now - sentAt >= 1000
        if (!changed && (settling || beat)) draw(true)
        if (changed || settling || beat) {
          track.requestFrame()
          sentAt = now
          sent++
        }
      }, 1000 / fps)
      const audio = new AudioContext()
      const tone = audio.createOscillator()
      const sink = audio.createMediaStreamDestination()
      tone.connect(sink)
      tone.start()
      const recorder = new MediaRecorder(new MediaStream([track, ...sink.stream.getAudioTracks()]), options)
      const chunks = []
      recorder.ondataavailable = event => event.data.size && chunks.push(event.data)
      let reference = ''
      recorder.start(1000)
      await new Promise(done => setTimeout(done, checkAt * 1000))
      reference = canvas.toDataURL('image/png')
      await new Promise(done => setTimeout(done, (seconds - checkAt) * 1000))
      await new Promise(done => {
        recorder.onstop = done
        recorder.stop()
      })
      clearInterval(timer)
      if (app) app.stop()
      else track.stop()
      await audio.close()
      const blob = new Blob(chunks, { type: recorder.mimeType })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return { mime: recorder.mimeType, size: blob.size, video: btoa(binary), reference, sent, looks, lookMs }
    },
    { options, hint, seconds, checkAt: CHECK_AT, scene, fps, gated, useApp },
  )
}

function probe(file) {
  const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' })
  const frames = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim()
  // key frames by the container's flag (the VP9 decoder of ffmpeg ignores -skip_frame)
  const flags = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=flags', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  const keys = flags.split('\n').filter(line => line.startsWith('K')).length
  return { whole: decode.status === 0 && !decode.stderr.trim(), errors: decode.stderr.trim().split('\n').filter(Boolean).slice(0, 3), frames: Number(frames), keyFrames: keys }
}

function textSimilarity(file, reference) {
  const frame = path.join(dir, `${path.basename(file)}.png`)
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `select='lte(t,${CHECK_AT})'`, '-fps_mode', 'vfr', '-update', '1', frame])
  const run = spawnSync('ffmpeg', ['-i', frame, '-i', reference, '-lavfi', `[0:v]${TEXT_AREA}[a];[1:v]${TEXT_AREA}[b];[a][b]ssim`, '-f', 'null', '-'], { encoding: 'utf8' })
  const match = /All:([\d.]+)/.exec(run.stderr)
  return match ? Number(match[1]) : null
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage()
await page.setContent('<!doctype html><title>gravação</title>')
if (appCode) await page.addScriptTag({ content: appCode })
const supported = await page.evaluate(mimes => mimes.filter(mime => MediaRecorder.isTypeSupported(mime)), [...new Set(Object.values(ALL).flatMap(v => v.videoMimes))])
const results = []
for (const id of ids) {
  const variant = ALL[id]
  const options = recorderOptions(variant, fps, mime => supported.includes(mime))
  const made = await record(page, options, variant.contentHint, Boolean(variant.gated), Boolean(appCode))
  const file = path.join(dir, `${id}.webm`)
  const reference = path.join(dir, `${id}-ref.png`)
  writeFileSync(file, Buffer.from(made.video, 'base64'))
  writeFileSync(reference, Buffer.from(made.reference.split(',')[1], 'base64'))
  const result = {
    id,
    label: variant.label,
    mime: made.mime,
    seconds,
    bytes: made.size,
    mbPerHour: Math.round((made.size / seconds) * 3600 / 1e6),
    ...probe(file),
    textSsim: textSimilarity(file, reference),
    ...(appCode ? { requested: made.sent, looks: made.looks, msPerLook: made.looks ? Number((made.lookMs / made.looks).toFixed(2)) : null } : {}),
  }
  results.push(result)
  console.log(`${id} ${result.mime}: ${result.mbPerHour} MB/h, inteiro ${result.whole}, ${result.frames} quadros (${result.keyFrames} chave), texto SSIM ${result.textSsim}${appCode ? `, ${made.sent} pedidos, ${result.looks} olhadas de ${result.msPerLook} ms` : ''}`)
}
const version = browser.version()
await browser.close()
writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), chromium: version, scene, seconds, fps, size: '1920x1080', ...(appScreen ? { tela: appScreen } : {}), supported, results }, null, 2) + '\n')
console.log(`arquivos em ${dir}; resumo em ${path.relative(root, out)}`)
