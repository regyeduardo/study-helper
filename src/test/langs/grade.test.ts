// Spec 004 (T010): correção sem IA. Formas equivalentes viram a mesma (da esquerda para a direita, a mais longa primeiro);
// won't = will not; diferença palavra a palavra; lacunas exatas. O servidor (grade_test.go) dá o mesmo resultado para a mesma tabela.
import { describe, expect, it } from 'vitest'

import { canonical, diff, exact, same } from '@/lib/langs/grade'

const GROUPS = [
  ['will not', "won't"],
  ['do not', "don't"],
  ['going to', 'gonna'],
]

describe('correção das frases', () => {
  it("won't = will not, nos dois sentidos, sem pontuação nem maiúsculas", () => {
    expect(same("I won't give up.", 'I will not give up', GROUPS)).toBe(true)
    expect(same('I WILL NOT give up!', "i won't give up", GROUPS)).toBe(true)
    expect(same("I won't go", "I don't go", GROUPS)).toBe(false)
  })

  it('pega a forma mais longa, da esquerda para a direita', () => {
    expect(canonical("I'm gonna say I won't", GROUPS)).toEqual(["i'm", 'going', 'to', 'say', 'i', 'will', 'not'])
  })

  it('diferença palavra a palavra: o que bateu, faltou e sobrou', () => {
    expect(diff('you can borrow my car as long as you are careful', 'you can borrow car as lung as you are careful', GROUPS)).toEqual([
      { w: 'you', k: 'ok' },
      { w: 'can', k: 'ok' },
      { w: 'borrow', k: 'ok' },
      { w: 'my', k: 'miss' },
      { w: 'car', k: 'ok' },
      { w: 'as', k: 'ok' },
      { w: 'lung', k: 'extra' },
      { w: 'long', k: 'miss' },
      { w: 'as', k: 'ok' },
      { w: 'you', k: 'ok' },
      { w: 'are', k: 'ok' },
      { w: 'careful', k: 'ok' },
    ])
  })

  it('lacuna: exata contra a lista de aceitas', () => {
    expect(exact(' Gave ', ['gave'])).toBe(true)
    expect(exact('give', ['gave', 'had given'])).toBe(false)
  })
})
