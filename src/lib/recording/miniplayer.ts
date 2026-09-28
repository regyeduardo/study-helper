export interface Meters {
  microphone: AnalyserNode | null
  computer: AnalyserNode | null
}

interface MiniplayerSource {
  preview: MediaStream | null
  meters: Meters
  computerAudio: string
}

const BACKGROUND = '#0b1220'
const WAVES: { key: keyof Meters; color: string; fill: string; label: string }[] = [
  { key: 'computer', color: '#34d399', fill: 'rgba(52, 211, 153, 0.16)', label: 'Computador' },
  { key: 'microphone', color: '#60a5fa', fill: 'rgba(96, 165, 250, 0.16)', label: 'Microfone' },
]

function drawWave(context: CanvasRenderingContext2D, analyser: AnalyserNode | null, samples: Uint8Array<ArrayBuffer>, width: number, height: number, color: string, fill: string): void {
  const middle = height / 2
  if (analyser) analyser.getByteTimeDomainData(samples)
  else samples.fill(128)
  const step = Math.max(1, Math.floor(samples.length / width))
  context.beginPath()
  context.moveTo(0, middle)
  for (let x = 0; x < width; x++) {
    const value = (samples[Math.min(samples.length - 1, x * step)] - 128) / 128
    context.lineTo(x, middle + value * middle * 0.9)
  }
  context.lineTo(width, middle)
  context.closePath()
  context.fillStyle = fill
  context.fill()
  context.strokeStyle = color
  context.lineWidth = 1.5
  context.stroke()
}

function drawLegend(context: CanvasRenderingContext2D, source: MiniplayerSource, height: number): void {
  context.font = '11px system-ui, sans-serif'
  context.textBaseline = 'middle'
  let x = 8
  for (const wave of WAVES) {
    const present = Boolean(source.meters[wave.key])
    const text = wave.key === 'computer' && !present ? 'Sem som do computador' : wave.label
    context.fillStyle = present ? wave.color : '#6b7280'
    context.beginPath()
    context.arc(x + 4, height - 10, 3.5, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = '#e5e7eb'
    context.fillText(text, x + 12, height - 10)
    x += context.measureText(text).width + 28
  }
}

export function mountMiniplayer(container: HTMLElement, source: MiniplayerSource): () => void {
  const doc = container.ownerDocument
  const view = doc.defaultView ?? window
  const frame = doc.createElement('div')
  frame.style.cssText = `position:relative;width:100%;height:100%;min-height:120px;background:${BACKGROUND};overflow:hidden`
  frame.dataset.miniplayer = ''
  const canvas = doc.createElement('canvas')
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%'
  frame.appendChild(canvas)
  let video: HTMLVideoElement | null = null
  if (source.preview) {
    video = doc.createElement('video')
    video.muted = true
    video.autoplay = true
    video.playsInline = true
    video.srcObject = source.preview
    video.style.cssText = 'position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);width:66%;max-height:70%;object-fit:contain;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.45);background:#000'
    frame.appendChild(video)
    void Promise.resolve(video.play()).catch(() => undefined)
  }
  container.appendChild(frame)
  const context = canvas.getContext('2d')
  const samples = new Uint8Array(1024)
  let handle = 0
  let stopped = false
  const paint = () => {
    if (stopped || !context) return
    const width = Math.max(1, Math.round(frame.clientWidth))
    const height = Math.max(1, Math.round(frame.clientHeight))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    context.fillStyle = BACKGROUND
    context.fillRect(0, 0, width, height)
    for (const wave of WAVES) drawWave(context, source.meters[wave.key], samples, width, height, wave.color, wave.fill)
    drawLegend(context, source, height)
    handle = view.requestAnimationFrame(paint)
  }
  handle = view.requestAnimationFrame(paint)
  return () => {
    stopped = true
    view.cancelAnimationFrame(handle)
    if (video) video.srcObject = null
    frame.remove()
  }
}
