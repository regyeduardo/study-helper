import { describe, expect, it, vi } from 'vitest'

// T188 (dono, 27/11): "Demorou um século pra gerar a transcrição analisando a tela pra depois falar que não foi possível ver a tela
// gravada… se marcar pra ver a tela é pra ver a tela". Antes, qualquer falha no meio (um quadro atrasado, UMA chamada de visão que
// falhou) jogava fora tudo o que já tinha sido lido e virava "a nota foi feita só com o som", e isso só depois de esperar o índice
// do vídeo inteiro.

import { Cancelled } from '@/controllers/ai.controller'
import { lookAtScreen, ScreenUnread, type ScreenTools } from '@/lib/generation/frames'
import type { GenerationSession } from '@/lib/generation/session'
import type { RecordingData, ScreenIndex } from '@/types/domain'

const recording: RecordingData = {
  blocks: [
    { speaker: 'speaker_0', start: 12, end: 30, text: 'Bom dia. Eu cuido do financeiro.' },
    { speaker: 'speaker_1', start: 31, end: 60, text: 'Olha esse slide aqui, o VGV do trimestre.' },
    { speaker: 'speaker_2', start: 61, end: 80, text: 'E o Pró Soluto entra quando?' },
  ],
  speakers: [
    { id: 'speaker_0', name: 'Falante 1', suggested: false },
    { id: 'speaker_1', name: 'Falante 2', suggested: false },
    { id: 'speaker_2', name: 'Falante 3', suggested: false },
  ],
  marks: [],
}
const video = new Blob(['v'], { type: 'video/webm' })
const vision = { provider: 'openrouter' as const, baseUrl: '', apiKey: 'k', model: 'visao' }
const INDEX: ScreenIndex = { width: 1920, height: 1080, area: { x: 0, y: 0, w: 1920, h: 1080 }, screens: [{ at: 1, end: 80 }] }

const session = (signal?: AbortSignal) => ({ chat: vi.fn(async () => '{"horas": ["00:31", "01:01"]}'), signal }) as unknown as GenerationSession
const grab = vi.fn(async (_video: Blob, times: number[]) => times.map(at => ({ at, image: `img-${at}`, signature: [at * 10, at * 10, at * 10, at * 10] })))
const never = <T>() => new Promise<T>(() => undefined)
const soon = <T>(work: Promise<T>) => Promise.race([work, new Promise<'preso'>(resolve => setTimeout(() => resolve('preso'), 300))])

describe('pedida a tela, ela é lida ou a leitura diz por que não (T188)', () => {
  it('todas as olhadas da IA de visão falharam: a leitura falha com o motivo, em vez de seguir só com o som', async () => {
    const see = vi.fn(async () => Promise.reject(new Error('O modelo de visão (OpenRouter) recusou o pedido (400): image input not supported')))
    const look = lookAtScreen(recording, video, vision, session(), { grab, see }, { strict: true })
    await expect(look).rejects.toBeInstanceOf(ScreenUnread)
    await expect(look).rejects.toThrow(/image input not supported/)
  })

  it('sem ser pedida (o padrão de antes), a mesma falha vira aviso, agora com o motivo', async () => {
    const see = vi.fn(async () => Promise.reject(new Error('recusou o pedido (400)')))
    const seen = await lookAtScreen(recording, video, vision, session(), { grab, see })
    expect(seen.warning).toMatch(/Não deu para ler a tela gravada/)
    expect(seen.warning).toContain('recusou o pedido (400)')
  })

  it('uma olhada que falha não joga fora as outras: o que veio fica, e o aviso diz quantas faltaram e por quê', async () => {
    const see = vi.fn(async (_settings: unknown, images: string[]) => (images.includes('img-31') ? Promise.reject(new Error('A IA não respondeu em 90 s.')) : images.length > 1 || images[0] === 'img-61' ? '{"texto": "Pró Soluto"}' : '{"nome": ""}'))
    const seen = await lookAtScreen(recording, video, vision, session(), { grab, see }, { strict: true })
    expect(seen.frames?.map(frame => frame.text)).toContain('Pró Soluto')
    expect(seen.warning).toMatch(/1 de \d+ olhadas da tela não vieram/)
    expect(seen.warning).toContain('A IA não respondeu em 90 s.')
  })

  it('a IA respondeu e a tela não tinha texto (só as câmeras): não é falha', async () => {
    const see = vi.fn(async () => '{"texto": "", "nome": ""}')
    const seen = await lookAtScreen(recording, video, vision, session(), { grab, see }, { strict: true })
    expect(seen.frames).toBeUndefined()
    expect(seen.warning).toBeUndefined()
  })

  it('pedida a tela, sem modelo de visão e sem o OCR: falha dizendo o que escolher, sem abrir o vídeo', async () => {
    const untouched = vi.fn()
    const look = lookAtScreen(recording, video, null, session(), { grab: untouched, see: vi.fn(), ocr: () => null }, { strict: true })
    await expect(look).rejects.toThrow(/Leitura de tela/)
    expect(untouched).not.toHaveBeenCalled()
  })

  it('a falha não espera o índice do vídeo inteiro (ele para junto)', async () => {
    let stopped: AbortSignal | undefined
    const index = vi.fn((_video: Blob, _ocr: unknown, signal?: AbortSignal) => ((stopped = signal), never<ScreenIndex | null>()))
    const see = vi.fn(async () => Promise.reject(new Error('fora do ar (503)')))
    const tools: ScreenTools = { grab, see, index, ocr: () => ({ read: vi.fn(async () => []) }) }
    expect(await soon(lookAtScreen(recording, video, vision, session(), tools, { strict: true }).catch(error => error))).toBeInstanceOf(ScreenUnread)
    expect(await soon(lookAtScreen(recording, video, vision, session(), tools))).toMatchObject({ warning: expect.stringMatching(/fora do ar/) })
    expect(stopped?.aborted).toBe(true)
  })

  it('o índice do vídeo inteiro só começa depois de pegar os quadros: os centenas de pulos dele não disputam com os quadros', async () => {
    const order: string[] = []
    const tools: ScreenTools = {
      grab: vi.fn(async (_video: Blob, times: number[]) => {
        order.push('quadros')
        await new Promise(resolve => setTimeout(resolve, 20))
        order.push('quadros prontos')
        return times.map(at => ({ at, image: `img-${at}`, signature: [at, at, at, at] }))
      }),
      see: vi.fn(async () => '{"texto": "VGV"}'),
      index: vi.fn(async () => (order.push('índice'), INDEX)),
      ocr: () => ({ read: vi.fn(async () => []) }),
    }
    const seen = await lookAtScreen(recording, video, vision, session(), tools, { strict: true })
    expect(order).toEqual(['quadros', 'quadros prontos', 'índice'])
    expect(seen.screenIndex).toEqual(INDEX)
  })

  it('o índice do vídeo inteiro que não termina junto com a leitura fica para a Ata: a transcrição não espera por ele, e ele para', async () => {
    let stopped: AbortSignal | undefined
    const index = vi.fn((_video: Blob, _ocr: unknown, signal?: AbortSignal) => ((stopped = signal), never<ScreenIndex | null>()))
    const tools: ScreenTools = { grab, see: vi.fn(async () => '{"texto": "VGV do trimestre"}'), index, ocr: () => ({ read: vi.fn(async () => []) }) }
    const seen = await soon(lookAtScreen(recording, video, vision, session(), tools, { strict: true, indexGraceMs: 50 }))
    expect(seen).not.toBe('preso')
    expect((seen as RecordingData).screenIndex).toBeUndefined()
    expect((seen as RecordingData).frames?.map(frame => frame.text)).toContain('VGV do trimestre')
    expect(stopped?.aborted).toBe(true)
  })

  it('cancelar chega às chamadas de visão (o sinal vai junto) e cancela, em vez de virar falha da tela', async () => {
    const controller = new AbortController()
    const see = vi.fn(async (_settings: unknown, _images: string[], _prompt: string, signal?: AbortSignal) => {
      controller.abort()
      expect(signal).toBe(controller.signal)
      throw new Cancelled()
    })
    await expect(lookAtScreen(recording, video, vision, session(controller.signal), { grab, see }, { strict: true })).rejects.toBeInstanceOf(Cancelled)
  })
})
