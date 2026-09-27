import { describe, expect, it } from 'vitest'

import { statementLines } from '@/lib/exam'

describe('statementLines: uma afirmação por linha', () => {
  it('quebra afirmações I, II, III escritas na mesma linha', () => {
    expect(statementLines('Considere: I. A rende. II. B cai. III. C fica.')).toBe('Considere:\nI. A rende.\nII. B cai.\nIII. C fica.')
  })

  it('quebra passos numerados 1., 2., 3.', () => {
    expect(statementLines('Passos: 1. soma 2. divide 3. multiplica')).toBe('Passos:\n1. soma\n2. divide\n3. multiplica')
  })

  it('não mexe em número com ponto de milhar nem em marcador sozinho', () => {
    expect(statementLines('Custa R$ 1.800 por mês. 2. nada')).toBe('Custa R$ 1.800 por mês. 2. nada')
  })

  it('não mexe em tabela', () => {
    const table = '| I. a | II. b |\n|---|---|\n| 1 | 2 |'
    expect(statementLines(`Veja:\n\n${table}`)).toBe(`Veja:\n\n${table}`)
  })
})
