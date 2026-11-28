import { describe, expect, it } from 'vitest'

// T193 (dono, 27/11: "se marcar pra ver a tela é pra ver a tela… quero 0 problemas"): a conferência antes de gastar pega o que já está
// quebrado; uma queda da IA de visão no meio da leitura ainda fazia a Ata (e a Aula e a Explicação "passo a passo") sair sem a tela, calada.
// Com a tela escolhida, se nenhuma pergunta à visão voltou, ou se a IA que acha onde a fala aponta caiu, a leitura falha antes de escrever.

import { buildAta, readVideoScreen } from '@/lib/generation/ata'
import { ScreenUnread } from '@/lib/generation/frames'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { fakeAi, meeting, textAnswer } from '@/test/generation/ata-fixture'
import { fakeOcr, recordedCall } from '@/test/generation/screen-fixture'

const startedAt = new Date(2026, 9, 28, 18, 15)
const difference = (a: number[], b: number[]) => Math.abs(a[0] - b[0])
const renderPrint = async () => 'data:image/jpeg;base64,PRINT'
// the speech points at the screen once ("E o BGV corrigido entra quando?", 01:40), so there are questions to the vision model
const asks = (system: string, user: string) => (system === PROMPTS.SCREEN_ASKS_PROMPT ? '{"horas": ["01:40"]}' : textAnswer(system, user))
const visionDown = () => {
  const ai = fakeAi({ text: asks })
  ai.see = async () => Promise.reject(new Error('O modelo de visão (OpenRouter) recusou o pedido (503): fora do ar'))
  return ai
}
const contextDown = () =>
  fakeAi({
    text: (system, user) => {
      if (system.includes('"horas"')) throw new Error('A IA não respondeu em 300 s.')
      return fakeAi().text('context', system, user)
    },
  })

describe('a tela escolhida que cai no meio da leitura (T193)', () => {
  it('a Ata com a tela escolhida: a visão caiu em todas as perguntas, falha com o motivo e nada é escrito', async () => {
    const ai = visionDown()
    const ata = buildAta({ recording: meeting, parts: ['resumo'], startedAt, screen: 'required' }, { ai, frames: recordedCall(), difference, renderPrint, ocr: fakeOcr() })
    await expect(ata).rejects.toBeInstanceOf(ScreenUnread)
    await expect(ata).rejects.toThrow(/fora do ar/)
    expect(ai.calls.some(call => call.pass === 'write')).toBe(false)
  })

  it('a Ata com a tela escolhida: a IA que acha onde a fala aponta caiu, falha com o motivo', async () => {
    const ata = buildAta({ recording: meeting, parts: ['resumo'], startedAt, screen: 'required' }, { ai: contextDown(), frames: recordedCall(), difference, renderPrint, ocr: fakeOcr() })
    await expect(ata).rejects.toThrow(/A tela não foi lida: A IA não respondeu em 300 s\./)
  })

  it('sem a tela escolhida (o padrão de antes), a mesma queda deixa a Ata sair', async () => {
    const done = await buildAta({ recording: meeting, parts: ['resumo'], startedAt }, { ai: visionDown(), frames: recordedCall(), difference, renderPrint, ocr: fakeOcr() })
    expect(done.markdown.length).toBeGreaterThan(0)
  })

  it('a Aula e a Explicação "passo a passo": a visão caiu em tudo, a leitura da tela falha com o motivo', async () => {
    const reading = readVideoScreen(meeting, { ai: visionDown(), frames: recordedCall(), difference, ocr: fakeOcr() }, () => {}, startedAt, { strict: true })
    await expect(reading).rejects.toBeInstanceOf(ScreenUnread)
  })

  it('a visão que respondeu ao menos uma vez não é queda: o que veio vale', async () => {
    const ai = fakeAi({ text: asks })
    const see = ai.see.bind(ai)
    let calls = 0
    ai.see = async (images, prompt, max) => (calls++ === 0 ? see(images, prompt, max) : Promise.reject(new Error('falhou uma')))
    await expect(readVideoScreen(meeting, { ai, frames: recordedCall(), difference, ocr: fakeOcr() }, () => {}, startedAt, { strict: true })).resolves.toEqual(expect.any(String))
  })
})
