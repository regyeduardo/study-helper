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

const QUIET_BOOST = 0.4

function drawWave(context: CanvasRenderingContext2D, analyser: AnalyserNode | null, samples: Uint8Array<ArrayBuffer>, left: number, width: number, top: number, height: number, color: string, fill: string): void {
  const reach = height / 2
  const middle = top + reach
  if (analyser) analyser.getByteTimeDomainData(samples)
  else samples.fill(128)
  const step = Math.max(1, Math.floor(samples.length / width))
  context.beginPath()
  context.moveTo(left, middle)
  for (let x = 0; x < width; x++) {
    const value = (samples[Math.min(samples.length - 1, x * step)] - 128) / 128
    context.lineTo(left + x, middle + Math.sign(value) * Math.abs(value) ** QUIET_BOOST * reach * 0.9)
  }
  context.lineTo(left + width, middle)
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

/**
 * The strip of the recording window (T175, mocks/gravar-reuniao, option I): each wave after its name, never under it; side by side
 * below the screen ('side'), one under the other when there is no screen ('stacked').
 */
export type Lanes = 'side' | 'stacked'

const LANES: { key: keyof Meters; color: string; fill: string; label: string; missing?: string }[] = [
  { key: 'microphone', color: '#60a5fa', fill: 'rgba(96, 165, 250, 0.16)', label: 'Microfone' },
  { key: 'computer', color: '#34d399', fill: 'rgba(52, 211, 153, 0.16)', label: 'Som do PC', missing: 'Sem som do computador' },
]
/** The names take at least this much, so the two waves start at the same place when both names are short. */
const NAME_COLUMN = 60

function drawLanes(context: CanvasRenderingContext2D, source: MiniplayerSource, samples: Uint8Array<ArrayBuffer>, width: number, height: number, lanes: Lanes): void {
  // the size of the names of the buttons below (11.5 px)
  context.font = '500 11.5px system-ui, sans-serif'
  context.textBaseline = 'middle'
  const boxes =
    lanes === 'side'
      ? [
          { left: 0, top: 0, width: width / 2, height },
          { left: width / 2, top: 0, width: width / 2, height },
        ]
      : [
          { left: 0, top: 0, width, height: height / 2 },
          { left: 0, top: height / 2, width, height: height / 2 },
        ]
  for (const [index, lane] of LANES.entries()) {
    const box = boxes[index]
    const meter = source.meters[lane.key]
    const text = !meter && lane.missing ? lane.missing : lane.label
    const middle = box.top + box.height / 2
    context.fillStyle = meter ? lane.color : '#6b7280'
    context.beginPath()
    context.arc(box.left + 11, middle, 3, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = '#e5e7eb'
    context.fillText(text, box.left + 19, middle)
    const start = box.left + 19 + Math.max(NAME_COLUMN, context.measureText(text).width) + 10
    const end = box.left + box.width - 10
    if (end > start) drawWave(context, meter, samples, start, end - start, box.top + box.height * 0.15, box.height * 0.7, lane.color, lane.fill)
  }
  if (lanes === 'side') {
    context.fillStyle = 'rgba(255, 255, 255, 0.08)'
    context.fillRect(Math.round(width / 2), 5, 1, Math.max(0, height - 10))
  }
}

export function mountMiniplayer(container: HTMLElement, source: MiniplayerSource, lanes?: Lanes): () => void {
  const doc = container.ownerDocument
  const view = doc.defaultView ?? window
  const frame = doc.createElement('div')
  // the strip of the recording window is shorter than the waves of before (26 px): no minimum there, or its middle falls outside it
  frame.style.cssText = `position:relative;width:100%;height:100%;min-height:${lanes ? 0 : 44}px;background:${BACKGROUND};overflow:hidden`
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
    if (lanes) drawLanes(context, source, samples, width, height, lanes)
    else {
      const lane = height / WAVES.length
      for (const [index, wave] of WAVES.entries()) drawWave(context, source.meters[wave.key], samples, 0, width, index * lane, lane, wave.color, wave.fill)
      drawLegend(context, source, height)
    }
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
