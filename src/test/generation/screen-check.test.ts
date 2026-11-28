import { describe, expect, it, vi } from 'vitest'

// T188 (dono, 27/11): "Demorou um século pra gerar a transcrição analisando a tela pra depois falar que não foi possível ver a tela
// gravada. Não quero que isso repita… se marcar pra ver a tela é pra ver a tela, e quando houver problemas semelhantes já avisar antes
// de iniciar qualquer gasto". A conferência roda antes de tudo: abre o vídeo, pula para três pontos e prova o modelo de visão com um
// quadro pequeno do próprio vídeo; o que impede ler a tela volta na hora, com o motivo.

import { checkScreen, type CheckTools, type ProbedFrame, probeVideo } from '@/lib/generation/screen-check'
import { recordedCall } from '@/test/generation/screen-fixture'

const video = new Blob(['v'], { type: 'video/webm' })
const vision = { provider: 'openrouter' as const, baseUrl: '', apiKey: 'k', model: 'visao' }
const slide = (at: number): ProbedFrame => ({ at, image: `data:image/jpeg;base64,q-${at}`, mean: 140, spread: 60 })
const black = (at: number): ProbedFrame => ({ at, image: `data:image/jpeg;base64,p-${at}`, mean: 4, spread: 1 })

function tools(over: Partial<CheckTools> = {}): CheckTools & { probe: ReturnType<typeof vi.fn>; see: ReturnType<typeof vi.fn> } {
  return { probe: vi.fn(async (_video: Blob, fractions: number[]) => fractions.map(fraction => slide(fraction * 600))), see: vi.fn(async () => 'ok'), ...over } as never
}

describe('a conferência antes de ler a tela (T188)', () => {
  it('sem modelo de visão e sem o OCR local, diz na hora que ninguém lê a tela, sem abrir o vídeo nem chamar a IA', async () => {
    const t = tools()
    const reason = await checkScreen(video, null, { ocr: false }, t)
    expect(reason).toMatch(/modelo/i)
    expect(reason).toMatch(/Vídeo|Leitura de tela/)
    expect(t.probe).not.toHaveBeenCalled()
    expect(t.see).not.toHaveBeenCalled()
  })

  it('um vídeo que não abre ou não pula para os quadros falha com o motivo, antes de qualquer chamada à IA', async () => {
    const t = tools({ probe: vi.fn(async () => Promise.reject(new Error('O vídeo da gravação não abriu.'))) })
    const reason = await checkScreen(video, vision, { ocr: true }, t)
    expect(reason).toContain('O vídeo da gravação não abriu.')
    expect(t.see).not.toHaveBeenCalled()
  })

  it('um vídeo todo escuro nos três pontos (a gravação não pegou a imagem) falha: não há tela para ler', async () => {
    const t = tools({ probe: vi.fn(async (_video: Blob, fractions: number[]) => fractions.map(fraction => black(fraction * 600))) })
    const reason = await checkScreen(video, vision, { ocr: true }, t)
    expect(reason).toMatch(/escuro/)
    expect(t.see).not.toHaveBeenCalled()
  })

  it('só um ponto escuro (um slide preto, a tela trocando) não é problema', async () => {
    const t = tools({ probe: vi.fn(async (_video: Blob, fractions: number[]) => fractions.map((fraction, index) => (index === 1 ? black(fraction * 600) : slide(fraction * 600)))) })
    expect(await checkScreen(video, vision, { ocr: true }, t)).toBeNull()
  })

  it('o modelo de visão é provado com um quadro do próprio vídeo, uma vez, com poucos tokens; recusou, falha com o motivo dele', async () => {
    const t = tools({ see: vi.fn(async () => Promise.reject(new Error('O modelo de visão (OpenRouter) recusou o pedido (400): image input not supported'))) })
    const reason = await checkScreen(video, vision, { ocr: true }, t)
    expect(reason).toContain('image input not supported')
    expect(t.see).toHaveBeenCalledTimes(1)
    const [settings, images, , , maxTokens] = t.see.mock.calls[0]
    expect(settings).toBe(vision)
    expect(images).toHaveLength(1)
    expect(images[0]).toMatch(/^data:image\/jpeg/)
    expect(maxTokens).toBeLessThanOrEqual(16)
  })

  it('tudo certo: nada a dizer, três pontos do vídeo conferidos (começo, meio e fim)', async () => {
    const t = tools()
    expect(await checkScreen(video, vision, { ocr: true }, t)).toBeNull()
    const fractions = t.probe.mock.calls[0][1] as number[]
    expect(fractions).toHaveLength(3)
    expect(fractions[0]).toBeLessThan(0.2)
    expect(fractions[2]).toBeGreaterThan(0.8)
  })

  it('sem modelo de visão, com o OCR local: confere o vídeo e não chama IA nenhuma (lê só o texto da tela)', async () => {
    const t = tools()
    expect(await checkScreen(video, null, { ocr: true }, t)).toBeNull()
    expect(t.probe).toHaveBeenCalledTimes(1)
    expect(t.see).not.toHaveBeenCalled()
  })

  it('cancelar durante a conferência cancela, em vez de virar motivo', async () => {
    const controller = new AbortController()
    controller.abort()
    const t = tools()
    await expect(checkScreen(video, vision, { ocr: true, signal: controller.signal }, t)).rejects.toThrow()
  })
})

describe('os quadros da conferência saem do mesmo leitor da leitura da tela (T188)', () => {
  it('começo, meio e fim do vídeo, com o brilho e o contraste de cada quadro; o leitor já aberto (Ata, Aula) fica aberto', async () => {
    const source = { ...recordedCall(), close: vi.fn() }
    const full = vi.spyOn(source, 'full')
    const frames = await probeVideo(source, [0.1, 0.5, 0.9])
    expect(full.mock.calls.map(call => call[0])).toEqual([32, 160, 288])
    expect(frames.map(frame => Math.round(frame.mean))).toEqual([0, 20, 30])
    expect(frames.every(frame => frame.spread === 0 && frame.image.startsWith('data:image/jpeg'))).toBe(true)
    expect(source.close).not.toHaveBeenCalled()
  })

  it('um vídeo que não diz quanto dura é provado num quadro só', async () => {
    const source = { ...recordedCall(), duration: 0 }
    const full = vi.spyOn(source, 'full')
    expect(await probeVideo(source, [0.1, 0.5, 0.9])).toHaveLength(1)
    expect(full).toHaveBeenCalledWith(1)
  })
})
