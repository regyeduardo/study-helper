import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

const { speechAudio } = vi.hoisted(() => ({ speechAudio: vi.fn() }))
vi.mock('@/controllers/langs.controller', async importOriginal => ({ ...(await importOriginal<object>()), speechAudio }))

import type { Card, LanguageText } from '@/controllers/langs.controller'
import { ListenCard } from '@/components/langs/cards/ListenCard'
import { grade, listenCards, newSlot, nextAfter, ready, type StudyState } from '@/lib/langs/listen'
import { say } from '@/lib/langs/voice'

// T037: the listening cards (delivery 1, only listening): each type graded by itself, no AI; options shuffled and kept; the model voice
// from the server, and the browser's when it fails.

const groups = [["won't", 'will not']]
const listenMc: Card = { id: 'l1', type: 'listen_mc', skill: 'listen', q: 'Ouça e escolha:', say: 'I walk to school', opts: ['Eu corro', 'Eu ando até a escola', 'Eu andei', 'Eu vou de carro', 'Eu ando pela escola'], a: 1 }
const pair: Card = { id: 'mp', type: 'minimal_pair', skill: 'listen', q: '"walk" ou "work"?', pair: ['walk', 'work'] }
const sameDiff: Card = { id: 'sd', type: 'same_diff', skill: 'listen', q: 'São iguais?', say: ['walk', 'work'], a: 'diff' }
const findDiff: Card = { id: 'fd', type: 'find_diff', skill: 'listen', q: 'Toque a palavra que mudou:', text: 'I used to walk to school', say: 'I used to run to school', a: 3 }
const stress: Card = { id: 'st', type: 'stress', skill: 'listen', q: 'Sílaba forte:', word: 'today', syllables: ['to', 'day'], a: 1 }
const dictation: Card = { id: 'dc', type: 'dictation', skill: 'listen', q: 'Ouça e escreva:', say: "I won't walk in the rain" }
const gap: Card = { id: 'dg', type: 'dictation_gap', skill: 'listen', q: 'Ouça e complete:', say: 'I used to walk to school', text: 'I ___ walk to ___', answers: [['used to'], ['school']] }

describe('correção sem IA', () => {
  it('cada tipo se corrige sozinho', () => {
    const slot = newSlot(listenMc)
    expect(slot.order).toHaveLength(5)
    expect([...(slot.order ?? [])].sort()).toEqual([0, 1, 2, 3, 4])
    expect(grade(listenMc, 1, slot, groups).ok).toBe(true)
    expect(grade(listenMc, 4, slot, groups)).toMatchObject({ ok: false, right: 'Eu ando até a escola' })
    const pick = newSlot(pair)
    expect([0, 1]).toContain(pick.pick)
    expect(grade(pair, pick.pick!, pick, groups).ok).toBe(true)
    expect(grade(pair, 1 - pick.pick!, pick, groups).ok).toBe(false)
    expect(grade(sameDiff, 1, {}, groups).ok).toBe(true)
    expect(grade(sameDiff, 0, {}, groups).ok).toBe(false)
    expect(grade(findDiff, 3, {}, groups)).toMatchObject({ ok: true, given: 'walk' })
    expect(grade(stress, 0, {}, groups)).toMatchObject({ ok: false, right: 'day' })
  })

  it('ditado aceita a forma equivalente e mostra a diferença palavra a palavra', () => {
    expect(grade(dictation, 'I will not walk in the rain.', {}, groups).ok).toBe(true)
    const wrong = grade(dictation, 'I want walk in rain', {}, groups)
    expect(wrong.ok).toBe(false)
    expect(wrong.diff?.some(word => word.k === 'miss' && word.w === 'the')).toBe(true)
  })

  it('lacuna do ditado é exata, uma por lacuna', () => {
    expect(grade(gap, ['used to', 'School'], {}, groups).ok).toBe(true)
    expect(grade(gap, ['use to', 'school'], {}, groups)).toMatchObject({ ok: false, right: 'used to · school' })
    expect(ready(gap, ['used to', ''])).toBe(false)
    expect(ready(dictation, '   ')).toBe(false)
    expect(ready(listenMc, null)).toBe(false)
    expect(ready(listenMc, 0)).toBe(true)
  })
})

describe('a fila de ouvir', () => {
  const text = {
    id: 't1',
    lines: ['I walk'],
    items: { walk: { area: 'lexico', kind: 'word', label: 'walk', meaning: 'andar', test: [listenMc, { id: 'r1', type: 'mc', skill: 'read', q: '?', opts: ['a', 'b', 'c', 'd', 'e'], a: 0 }] } },
    practice: [pair, { id: 'sp', type: 'speak', skill: 'speak', q: 'Fale', target: 'I walk', mode: 'repeat' }, dictation],
    context: [],
  } as unknown as LanguageText

  it('só entram os cards de ouvir, com a parte de cada um', () => {
    expect(listenCards(text).map(entry => `${entry.stage}:${entry.card.id}`)).toEqual(['test:l1', 'practice:mp', 'practice:dc'])
  })

  it('os errados voltam uma vez no fim', () => {
    const state: StudyState = { step: 'cards', at: 0, order: ['l1', 'mp', 'dc'], wrong: [], again: [], slots: {}, right: 0, answered: 0 }
    let next = nextAfter(state, 'l1', false)
    next = nextAfter(next, 'mp', true)
    next = nextAfter(next, 'dc', true)
    expect(next).toMatchObject({ step: 'cards', order: ['l1'], at: 0, again: ['l1'], right: 2, answered: 3 })
    next = nextAfter(next, 'l1', false)
    expect(next.step).toBe('done')
    expect(next.answered).toBe(3)
  })
})

describe('o card na tela', () => {
  beforeEach(() => {
    speechAudio.mockReset()
    speechAudio.mockResolvedValue(new Blob(['mp3'], { type: 'audio/mpeg' }))
  })

  it('mostra as 5 opções na ordem guardada e marca a escolhida', () => {
    const onAnswer = vi.fn()
    const slot = { order: [4, 3, 2, 1, 0] }
    render(<ListenCard card={listenMc} locale="en-US" slot={slot} answer={null} onAnswer={onAnswer} checked={false} autoPlay={false} />)
    const options = screen.getAllByRole('radio')
    expect(options.map(option => option.textContent)).toEqual(['Eu ando pela escola', 'Eu vou de carro', 'Eu andei', 'Eu ando até a escola', 'Eu corro'])
    fireEvent.click(options[3])
    expect(onAnswer).toHaveBeenCalledWith(1)
  })

  it('depois de conferir, a certa e a errada se distinguem sem depender da cor', () => {
    render(<ListenCard card={listenMc} locale="en-US" slot={{ order: [0, 1, 2, 3, 4] }} answer={0} onAnswer={vi.fn()} checked autoPlay={false} />)
    expect(screen.getByRole('radio', { name: /Eu ando até a escola \(a certa\)/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Eu corro \(sua resposta\)/ })).toBeInTheDocument()
  })

  it('as setas andam entre as respostas', () => {
    render(<ListenCard card={sameDiff} locale="en-US" slot={{}} answer={null} onAnswer={vi.fn()} checked={false} autoPlay={false} />)
    const [same, different] = screen.getAllByRole('radio')
    same.focus()
    fireEvent.keyDown(same, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(different)
    fireEvent.keyDown(different, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(same)
  })

  it('ditado com lacunas: um campo por lacuna', () => {
    const onAnswer = vi.fn()
    render(<ListenCard card={gap} locale="en-US" slot={{}} answer={['', '']} onAnswer={onAnswer} checked={false} autoPlay={false} />)
    const fields = screen.getAllByRole('textbox')
    expect(fields).toHaveLength(2)
    fireEvent.change(fields[1], { target: { value: 'school' } })
    expect(onAnswer).toHaveBeenCalledWith(['', 'school'])
  })

  it('palavra diferente: cada palavra do texto é um botão', () => {
    const onAnswer = vi.fn()
    render(<ListenCard card={findDiff} locale="en-US" slot={{}} answer={null} onAnswer={onAnswer} checked={false} autoPlay={false} />)
    fireEvent.click(screen.getByRole('radio', { name: 'walk' }))
    expect(onAnswer).toHaveBeenCalledWith(3)
  })
})

describe('a voz', () => {
  const played: string[] = []
  beforeEach(() => {
    played.length = 0
    speechAudio.mockReset()
    URL.createObjectURL = vi.fn(() => 'blob:voz')
    vi.stubGlobal(
      'Audio',
      class {
        playbackRate = 1
        onended: (() => void) | null = null
        onerror: (() => void) | null = null
        constructor(readonly src: string) {}
        play() {
          played.push(`${this.src}@${this.playbackRate}`)
          setTimeout(() => this.onended?.(), 0)
          return Promise.resolve()
        }
        pause() {}
      },
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('toca a voz do servidor, uma vez por frase (cache), e devagar', async () => {
    speechAudio.mockResolvedValue(new Blob(['mp3']))
    await say('I walk', 'en-US')
    await say('I walk', 'en-US', { slow: true })
    expect(speechAudio).toHaveBeenCalledTimes(1)
    expect(played).toEqual(['blob:voz@1', 'blob:voz@0.7'])
  })

  it('quando o servidor falha, usa a voz do navegador', async () => {
    speechAudio.mockRejectedValue(new Error('provider_down'))
    const spoken: { text: string; lang: string }[] = []
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      lang = ''
      rate = 1
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(readonly text: string) {}
    })
    vi.stubGlobal('speechSynthesis', {
      cancel() {},
      speak(utterance: { text: string; lang: string; onend: () => void }) {
        spoken.push({ text: utterance.text, lang: utterance.lang })
        setTimeout(() => utterance.onend(), 0)
      },
    })
    await act(async () => {
      await say('Hola amigo', 'es-ES')
    })
    expect(spoken).toEqual([{ text: 'Hola amigo', lang: 'es-ES' }])
  })
})
