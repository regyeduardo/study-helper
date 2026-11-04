import { describe, expect, it } from 'vitest'

import { closePairs, SURE, voteTerms } from '@/lib/generation/screen-terms'

const read = (text: string, confidence: number) => ({ text, confidence })

describe('what the local OCR read on the screens', () => {
  it('only sure readings are exact terms; an unsure one (7 px Excel text) is only a hint', () => {
    const terms = voteTerms([
      [read('INCC-M', 0.97), read('Variação 0,85%', 0.95), read('Matriz Sensibilidade', 0.96)],
      [read('DP301', 0.95), read('3.461.387,84', 0.96), read('=SE(CZ297<$C$4;0;SE($CZ$8="FGT5"', 0.62)],
    ])
    expect(SURE).toBeGreaterThanOrEqual(0.85)
    expect(terms.exact).toEqual(expect.arrayContaining(['INCC-M', '0,85%', 'Matriz Sensibilidade', 'DP301', '3.461.387,84']))
    expect(terms.exact.join(' ')).not.toMatch(/FGT5|CZ297/)
    expect(terms.doubtful.join(' ')).toMatch(/FGT5/)
  })

  it('an unsure reading is never applied as a correction', () => {
    const terms = voteTerms([[read('FGT5', 0.6), read('INCC Mss', 0.55)]])
    expect(closePairs('O FGTS entra no INCC mês.', terms.exact)).toEqual([])
    expect(terms.exact).toEqual([])
  })

  it('the same term on several screens is voted: the sure reading wins over the misread ones', () => {
    const tiles = voteTerms([[read('Natália Lenza', 0.96)], [read('Natália Leiza', 0.84)], [read('Natália Leiza', 0.86)]])
    expect(tiles.exact).toContain('Natália Lenza')
    expect(tiles.exact.join(' ')).not.toContain('Leiza')
    const names = voteTerms([[read('Henrique Souza', 0.95)], [read('Henrique Souza', 0.94)], [read('Henrique Sousa', 0.93)]])
    expect(names.exact).toContain('Henrique Souza')
    expect(names.exact).not.toContain('Henrique Sousa')
  })

  it('codes and numbers are never merged by the vote: DP301 and DP302 are two cells', () => {
    const terms = voteTerms([[read('DP301', 0.95)], [read('DP302', 0.95)], [read('DP301', 0.94)]])
    expect(terms.exact).toEqual(expect.arrayContaining(['DP301', 'DP302']))
  })
})

describe('the speech is corrected only when it agrees closely with the screen', () => {
  const exact = ['VGV', 'FGTS', 'Natália Lenza', 'Fluxo_Analitico', 'DP301', 'Caxias', 'Campos']

  it('same sound or same spelling: a correction pair', () => {
    const pairs = closePairs('O BGV e o FCTS que a Natalia Lenza mostrou.', exact)
    expect(pairs).toEqual(expect.arrayContaining([
      { heard: 'BGV', term: 'VGV' },
      { heard: 'FCTS', term: 'FGTS' },
      { heard: 'Natalia Lenza', term: 'Natália Lenza' },
    ]))
    expect(pairs).toHaveLength(3)
  })

  it('speech and screen that disagree: what was said stays', () => {
    expect(closePairs('Abre a planilha de fluxo analítico na célula DP302.', exact)).toEqual([])
    expect(closePairs('Ela mora numa casa no campo.', exact)).toEqual([])
    expect(closePairs('O VGV e o FGTS já estão certos.', exact)).toEqual([])
    expect(closePairs('O ABC subiu.', exact)).toEqual([])
  })
})
