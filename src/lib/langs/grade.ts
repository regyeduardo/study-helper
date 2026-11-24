/**
 * Correção sem IA (spec 004): compara com a resposta esperada. Formas equivalentes do idioma (won't = will not) viram a mesma
 * forma nos dois lados antes de comparar; lacunas comparam exato contra a lista de respostas aceitas. O servidor
 * (api/internal/langs/grade.go) faz igual, para a mesma tabela.
 */

export const clean = (text: string) =>
  String(text)
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/[.,!?;:"“”()¿¡…]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const tokens = (text: string) => clean(text).split(' ').filter(Boolean)

/** A forma por extenso de um grupo (a de mais palavras; no empate, a primeira): "won't" e "will not" viram "will not". */
const spelledOut = (group: string[]) => group.map(tokens).reduce((best, form) => (form.length > best.length ? form : best), [] as string[])

/**
 * Troca cada forma da tabela pela forma por extenso do seu grupo, da esquerda para a direita, pegando a forma mais longa. Por
 * extenso, grupos que se cruzam dão o mesmo ("he's not" = "he isn't" = "he is not"; "I will not" = "I won't" = "I'll not").
 */
export function canonical(text: string, groups: string[][]): string[] {
  const forms = groups.flatMap(group => group.map(form => ({ form: tokens(form), to: spelledOut(group) }))).sort((a, b) => b.form.length - a.form.length)
  const words = tokens(text)
  const out: string[] = []
  for (let i = 0; i < words.length; ) {
    const hit = forms.find(item => item.form.length && item.form.every((word, k) => words[i + k] === word))
    if (hit) {
      out.push(...hit.to)
      i += hit.form.length
    } else out.push(words[i++])
  }
  return out
}

export const same = (a: string, b: string, groups: string[][]) => canonical(a, groups).join(' ') === canonical(b, groups).join(' ')

export const exact = (value: string, accepted: string | string[]) => ([] as string[]).concat(accepted).some(item => clean(item) === clean(value))

export interface DiffWord {
  w: string
  k: 'ok' | 'miss' | 'extra'
}

/** Diferença palavra a palavra (LCS): o que bateu, o que faltou e o que sobrou. */
export function diff(expected: string, given: string, groups: string[][]): DiffWord[] {
  const e = canonical(expected, groups)
  const g = canonical(given, groups)
  const m = e.length
  const n = g.length
  const L = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = e[i] === g[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out: DiffWord[] = []
  let i = 0
  let j = 0
  while (i < m || j < n) {
    if (i < m && j < n && e[i] === g[j]) {
      out.push({ w: e[i], k: 'ok' })
      i++
      j++
    } else if (j < n && (i >= m || L[i][j + 1] >= L[i + 1][j])) out.push({ w: g[j++], k: 'extra' })
    else out.push({ w: e[i++], k: 'miss' })
  }
  return out
}
