// "Levantamento de tarefas": passes 2-4 of relatorio.md (candidates, merge + review, look + verify,
// write) and the assembly in the gold structure. Rules added on top of the report: a task must have
// been SPOKEN (a quote found in the speech), "aceita" only with the owner's own words, "Ficou sem dono".
import { Cancelled } from '@/controllers/ai.controller'
import type { AtaAi } from '@/lib/generation/ata-ai'
import * as P from '@/lib/generation/ata-prompts'
import { type Context, clock, type Json, jsonIn, list, type Material, oneLine, plainText, pool, secs, short } from '@/lib/generation/meeting-material'

export interface PrintRequest {
  name: string
  at: number
  marcar: string
  legenda: string
}

export interface TasksResult {
  /** Markdown of the part, headings starting at "###"; prints as "{{img:NAME}}" lines. */
  markdown: string
  title: string
  tasks: Json[]
  dropped: Json[]
  prints: PrintRequest[]
}

const WINDOW = 420
const STEP = 360
const MAX_TASK_CHARS = 1300
const REVIEW_VOTES = 5
const CLOSING_SECONDS = 100

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

async function quiet<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work
  } catch (error) {
    if (error instanceof Cancelled) throw error
    return null
  }
}

export interface Said {
  /** Some piece (3+ words) of the quote really was SAID (screen text never said does not count). */
  some(quote: unknown): boolean
  /** Every piece of the quote was said: the quote is literal. */
  all(quote: unknown): boolean
}

export function saidIn(speech: string[]): Said {
  const spoken = ` ${plainText(speech.join(' '))} `
  const pieces = (quote: unknown) =>
    String(quote ?? '')
      .split(/\.\.\.|…/)
      .map(plainText)
      .filter(piece => piece.length > 3)
  return {
    some: quote => pieces(quote).some(piece => piece.split(' ').length >= 3 && spoken.includes(` ${piece} `)),
    all: quote => {
      const found = pieces(quote)
      return found.length > 0 && found.every(piece => spoken.includes(piece))
    },
  }
}

const firstName = (name: unknown) => plainText(String(name ?? '')).split(' ')[0]

/** Code rules after the verifier (relatorio-v2): speech evidence is mandatory, "aceita" needs the owner's own words, Base only with literal quotes. */
export function enforce(task: Json, said: Said): Json {
  if (task.manter === false) return task
  const proof = [task.prova_fala, ...list(task.base)].find(item => item && said.some(item.citacao))
  if (!proof) return { ...task, manter: false, motivo: `sem fala que prove a tarefa (${task.motivo ?? ''})` }
  const out: Json = { ...task, prova_fala: proof }
  if (out.situacao === 'aceita') {
    const accepted = out.aceite
    const owners = plainText(String(out.dono ?? '')).split(' ')
    if (!accepted || !said.some(accepted.citacao) || !owners.includes(firstName(accepted.quem))) Object.assign(out, { situacao: 'pedida', situacao_detalhe: 'ninguém disse na gravação que faz' })
  }
  const base = list(out.base).filter(item => said.all(item.citacao))
  if (!base.some(item => item.minuto === proof.minuto)) base.unshift(proof)
  out.base = base.slice(0, 4)
  return out
}

/** Long quotes are cut at a word boundary (the kept part stays literal). */
export function clipQuote(quote: unknown): string {
  const text = String(quote ?? '').trim()
  if (text.length <= 110) return text
  const cut = text.slice(0, 100)
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:.]$/, '') + '...'
}

export async function findCandidates(m: Material, ctx: Context, ai: AtaAi): Promise<Json[]> {
  const chunks = Array.from({ length: Math.max(1, Math.ceil(m.end / STEP)) }, (_, i) => [i * STEP, i * STEP + WINDOW]).filter(([a]) => a < Math.max(1, m.end))
  const got = await pool(chunks, 6, async ([a, z]) => {
    const user = `${m.dados}\n\n${ctx.contexto}\n\nFALAS DO TRECHO (${clock(a)}–${clock(z)}):\n${m.falasEntre(a, z)}\n\nLEITURA DA TELA NO TRECHO:\n${m.telaEntre(a - 60, z) || 'nada'}`
    return list(jsonIn(await ai.text('candidates', P.CANDIDATAS, user, { max: 6000, json: true }))?.tarefas)
  })
  return got.flat().map((c, i) => ({ id: `c${i + 1}`, ...c }))
}

export interface Plan {
  tasks: Json[]
  dropped: Json[]
}

const COMMIT = /\b(vou|eu fa[cç]o|deixa comigo|eu mando|pode deixar)\b/i

/** Majority of K reviewer votes per task; without a majority the task stays. */
export function voteDecisions(votes: Json[][], count: number): Json[] {
  const key = (d: Json) => (d.decisao === 'passo_de' ? `passo_de:${Number(d.de)}` : String(d.decisao))
  return Array.from({ length: count }, (_, i) => {
    const mine = votes.map(vote => vote.find(d => Number(d.n) === i + 1)).filter((d): d is Json => Boolean(d))
    const groups = new Map<string, Json[]>()
    for (const d of mine) groups.set(key(d), [...(groups.get(key(d)) ?? []), d])
    const [best] = [...groups.values()].sort((a, b) => b.length - a.length)
    return best && best.length > votes.length / 2 ? { ...best[0], n: i + 1, votos: best.length } : { n: i + 1, decisao: 'fica', de: 0, motivo: 'sem maioria', votos: 0 }
  })
}

export async function mergeAndReview(m: Material, ctx: Context, ai: AtaAi, cands: Json[], said: Said): Promise<Plan> {
  const byId: Record<string, Json> = Object.fromEntries(cands.map(c => [c.id, c]))
  const lines = cands.map(c => `${c.id} · ${c.minuto} · ${c.o_que} · pedida por ${c.pedida_por || '?'} · dono: ${c.dono || '?'} · prazo: ${c.prazo || '-'} · ${c.situacao} · "${c.citacao}" · ${c.detalhes ?? ''} · tela: ${c.tela ?? ''}`).join('\n')
  const merged = jsonIn(await ai.text('candidates', P.JUNTAR, `${m.dados}\n\n${ctx.contexto}\n\nCANDIDATAS:\n${lines}`, { max: 5000, json: true })) ?? {}
  const dropped: Json[] = list(merged.descartadas)
  const ids = (t: Json): string[] => (Array.isArray(t.candidatas) ? t.candidatas.map(String) : [])
  // evidence gate: a group with no candidate quote that was actually SAID (only screen/card text) is not a task
  const tarefas = list(merged.tarefas).filter(t => {
    if (ids(t).some(id => said.some(byId[id]?.citacao))) return true
    dropped.push({ candidatas: t.candidatas, motivo: `sem fala: só na tela (${t.titulo ?? ''})` })
    return false
  })
  if (!tarefas.length) return { tasks: [], dropped }
  const spokenOf = (t: Json) => ids(t).map(id => byId[id]).filter(c => c && said.some(c.citacao))
  const review = `${ctx.contextoCurto}\n\nTAREFAS:\n${tarefas
    .map((t, i) => {
      const first = secs(spokenOf(t)[0]?.minuto)
      const around = isNaN(first) ? '' : short(m.falasEntre(first - 10, first + 15).replace(/\n/g, ' / '), 400)
      return `${i + 1}. ${t.titulo}\n   tela: ${[...new Set(ids(t).map(id => byId[id]?.tela).filter(Boolean))].join(' / ') || '?'}\n   falas: ${spokenOf(t)
        .slice(0, 4)
        .map(c => `${c.minuto} ${c.pedida_por || '?'}: "${short(c.citacao, 140)}"`)
        .join(' | ')}\n   em volta: ${around}`
    })
    .join('\n')}`
  const valid = (d: Json) =>
    d &&
    Number(d.n) >= 1 &&
    Number(d.n) <= tarefas.length &&
    (d.decisao === 'fica' || d.decisao === 'sai' || (d.decisao === 'passo_de' && Number(d.de) >= 1 && Number(d.de) <= tarefas.length && Number(d.de) !== Number(d.n)))
  // K calls at temperature 0 and a majority vote per task: one call alone flips decisions between runs
  const votes = await pool(
    Array.from({ length: REVIEW_VOTES }, (_, k) => k + 1),
    REVIEW_VOTES,
    async seed => list(jsonIn((await quiet(ai.text('review', P.REVISAR, review, { max: 3000, json: true, temperature: 0, seed }))) ?? '')?.decisoes).filter(valid),
  )
  const decisions = voteDecisions(votes, tarefas.length)
  // a piece someone committed to in speech ("vou ...") stays its own task when its parent has no such commitment
  const committed = (t: Json | undefined) => Boolean(t) && spokenOf(t!).some(c => COMMIT.test(String(c.citacao)))
  for (const d of decisions) if (d.decisao === 'passo_de' && committed(tarefas[d.n - 1]) && !committed(tarefas[Number(d.de) - 1])) Object.assign(d, { decisao: 'fica', de: 0, motivo: `regra: tem aceite próprio (${d.motivo ?? ''})` })
  const byN = new Map<number, Json>(decisions.map(d => [Number(d.n), d]))
  const root = (n: number, seen = new Set<number>()): number => {
    const d = byN.get(n)
    if (d?.decisao !== 'passo_de' || seen.has(n)) return n
    seen.add(n)
    const parent = Number(d.de)
    return parent >= 1 && parent <= tarefas.length && parent !== n ? root(parent, seen) : n
  }
  const kept: Json[] = []
  tarefas.forEach((t, i) => {
    const d = byN.get(i + 1)
    if (d?.decisao === 'sai') return void dropped.push({ candidatas: t.candidatas, motivo: `revisão: ${d.motivo ?? ''}` })
    if (root(i + 1) === i + 1) kept.push({ ...t, _n0: i + 1, partes: [] })
  })
  tarefas.forEach((t, i) => {
    const r = root(i + 1)
    if (r === i + 1 || byN.get(i + 1)?.decisao === 'sai') return
    const parent = kept.find(k => k._n0 === r)
    if (!parent) return
    parent.candidatas = [...ids(parent), ...ids(t)]
    parent.momentos = [...(Array.isArray(parent.momentos) ? parent.momentos : []), ...(Array.isArray(t.momentos) ? t.momentos : [])]
    parent.partes.push(t.titulo)
  })
  return { tasks: kept.map(t => ({ ...t, _cands: ids(t).map(id => byId[id]).filter(Boolean) })), dropped }
}

export type LookFn = (at: number) => Promise<string | null>

export async function verifyTasks(m: Material, ctx: Context, ai: AtaAi, plan: Plan, look: LookFn | null, said: Said): Promise<Json[]> {
  const lista = plan.tasks.map((t, i) => `${i + 1}. ${t.titulo}`).join('\n')
  const verified = await pool(plan.tasks, 6, async (t, i) => {
    const mine: Json[] = t._cands
    const moments = [
      ...new Set(
        [...(Array.isArray(t.momentos) ? t.momentos : []), ...mine.map(c => c.minuto), ...mine.flatMap(c => (Array.isArray(c.outros_minutos) ? c.outros_minutos : []))].map(secs).filter(n => !isNaN(n)),
      ),
    ]
      .slice(0, 6)
      .sort((a, b) => a - b)
    const main = mine[0]
    const seen = look
      ? await pool(moments.slice(0, 3), 3, async at => {
          const image = await quiet(look(at))
          if (!image) return { minuto: clock(at), visto: null }
          const prompt = P.VER_TAREFA.replace('{{minuto}}', clock(at))
            .replace('{{titulo}}', String(t.titulo ?? ''))
            .replace('{{citacao}}', short(main?.citacao, 200))
          return { minuto: clock(at), visto: jsonIn((await quiet(ai.see([image], prompt, 1500))) ?? '') }
        })
      : []
    // the closing of the meeting is where general commitments ("foco nisso") usually are
    const windows = [...moments.map(at => [at - 75, at + 45]), [m.end - CLOSING_SECONDS, m.end]]
    const falas = [...new Set(windows.flatMap(([a, z]) => m.falasEntre(a, z).split('\n')))].filter(Boolean).sort().join('\n')
    const user = `${m.dados}\n\n${ctx.contextoCurto}\n\nTODAS AS TAREFAS (número: título):\n${lista}\n\nTAREFA A VERIFICAR: ${i + 1}. ${t.titulo}${t.depende_de ? ` (depende de: ${t.depende_de})` : ''}${t.partes?.length ? `\nESTA TAREFA INCLUI, COMO PASSOS: ${t.partes.join('; ')}` : ''}\nCANDIDATAS QUE A ORIGINARAM:\n${JSON.stringify(mine)}\n\nFALAS EM VOLTA DOS MOMENTOS:\n${falas}\n\nLEITURA DA TELA NO TRECHO:\n${m.telaJanelas(moments) || 'nada'}\n\nO QUE SE VIU NA TELA NO SEGUNDO EXATO:\n${JSON.stringify(seen)}\n\nCATÁLOGO DE TELAS DA REUNIÃO (para os prints):\n${m.catalogoCurto || 'nenhum'}`
    const v = jsonIn(await ai.text('write', P.VERIFICAR, user, { max: 5000, json: true }))
    return enforce({ ...(v ?? { manter: false, motivo: 'sem JSON' }), _n: i + 1, _titulo: t.titulo } as Json, said)
  })
  return verified.filter(v => v.manter !== false && v.titulo)
}

export async function writeTasks(m: Material, ctx: Context, ai: AtaAi, tasks: Json[]): Promise<{ bodies: string[]; geral: Json | null; pending: Json | null }> {
  const LISTA = tasks.map((t, i) => `${i + 1}. ${t.titulo} · ${t.dono} · ${t.prazo}`).join('\n')
  const tarefasMin = tasks.map((t, i) => `${i + 1}. ${t.titulo} · onde: ${short(t.onde, 160)} · falas: ${list(t.base).map(b => b.minuto).join(', ')}`).join('\n')
  const hidden = ['prints', 'prova_fala', 'aceite', 'manter', 'motivo']
  const [bodies, geral, pending] = await Promise.all([
    pool(tasks, 6, async (t, i) => {
      const clean = Object.fromEntries(Object.entries({ ...t, base: list(t.base).slice(0, 3).map(b => ({ ...b, citacao: clipQuote(b.citacao) })) }).filter(([k]) => !k.startsWith('_') && !hidden.includes(k)))
      let body = await ai.text('write', P.ESCREVER_TAREFA, `GLOSSÁRIO:\n${ctx.glossario}\n\nTODAS AS TAREFAS:\n${LISTA}\n\nTAREFA ${i + 1} (verificada):\n${JSON.stringify(clean, null, 1)}`, { max: 3000, json: false })
      if (body.length > MAX_TASK_CHARS) {
        const shorter = await quiet(ai.text('write', P.ENCURTAR.replace('{{max}}', String(MAX_TASK_CHARS - 200)), body, { max: 3000, json: false }))
        if (shorter && shorter.includes('**Dono:**') && shorter.length < body.length) body = shorter
      }
      return body
    }),
    ai.text('write', P.ESCREVER_GERAL, `${m.dados}\n\n${ctx.contextoGeral}\n\nTAREFAS:\n${LISTA}`, { max: 5000, json: true }).then(jsonIn),
    quiet(ai.text('pending', P.PENDENCIAS, `${m.dados}\n\n${ctx.contextoCurto}\n\nTAREFAS JÁ LEVANTADAS:\n${tarefasMin}\n\nFALAS:\n${m.falas}`, { max: 4000, json: true, temperature: 0 })).then(text => jsonIn(text ?? '')),
  ])
  return { bodies, geral, pending }
}

const PENDING_KINDS = ['divergencias', 'cobrancas_de_fora', 'vai_ter', 'perguntas_abertas']

/** "Ficou sem dono": not equal to a task, literal quotes only, and not all of its minutes already cited by a task. */
export function unowned(pending: Json | null, bodies: string[], said: Said): Json[] {
  const cited = new Set(bodies.flatMap(b => [...String(b).matchAll(/\[▸\s*(\d{1,2}:\d{2})/g)].map(found => found[1].padStart(5, '0'))))
  const items = Array.isArray(pending?.sem_dono) ? list(pending!.sem_dono) : PENDING_KINDS.flatMap(kind => list(pending?.[kind]))
  return items
    .filter(item => !Number(item.igual_a_tarefa))
    .slice(0, 5)
    .map(item => ({ ...item, base: list(item.base).filter(b => said.all(b.citacao)) }))
    .filter(item => {
      const minutes = item.base.map((b: Json) => String(b.minuto).padStart(5, '0'))
      return minutes.length > 0 && minutes.some((minute: string) => !cited.has(minute))
    })
}

/** Gold structure (02z-tarefas-claude.md), one level down so it fits as a part of the Ata. */
export function assembleTasks(ctx: Context, tasks: Json[], bodies: string[], geral: Json | null, semDono: Json[] = []): { markdown: string; title: string; prints: PrintRequest[] } {
  const title = oneLine(geral?.titulo ?? ctx.brief.assunto ?? '')
  const parts: string[] = []
  const contexto = Array.isArray(geral?.contexto) ? geral!.contexto : [ctx.brief.contexto ?? '']
  parts.push(contexto.map(oneLine).filter(Boolean).join('\n'), '', '### Lista', '')
  if (!tasks.length) parts.push('Nenhuma tarefa apareceu na reunião.')
  tasks.forEach((t, i) => parts.push(`- [ ] [${cap(oneLine(t.titulo))}](#t${i + 1}) · ${oneLine(t.dono) || 'a confirmar'} · ${oneLine(t.prazo) || 'sem prazo dito'}`))
  parts.push('')
  const prints: PrintRequest[] = []
  tasks.forEach((t, i) => {
    const body = String(bodies[i] ?? '')
      .replace(/^#+.*\n/gm, '')
      .trim()
    parts.push(`<a id="t${i + 1}"></a>`, `#### ${i + 1}. ${cap(oneLine(t.titulo))}`, '', body, '')
    list(t.prints)
      .slice(0, 2)
      .forEach((p, k) => {
        const at = secs(p.minuto)
        if (isNaN(at)) return
        const name = `t${i + 1}-${k + 1}.jpg`
        prints.push({ name, at, marcar: oneLine(p.marcar), legenda: oneLine(p.legenda || p.marcar) })
        parts.push(`{{img:${name}}}`)
      })
    if (list(t.prints).length) parts.push('')
  })
  if (semDono.length) {
    parts.push('### Ficou sem dono', '')
    for (const s of semDono)
      parts.push(
        `- **${oneLine(s.assunto).replace(/\*/g, '').replace(/\.$/, '')}.** ${oneLine(s.texto)} ${list(s.base)
          .map(b => `[▸ ${oneLine(b.minuto)}] "${oneLine(b.citacao)}"`)
          .join(' · ')}`.trim(),
      )
    parts.push('')
  }
  const taskText = ` ${plainText(bodies.join(' ') + ' ' + tasks.map(t => t.titulo).join(' '))} `
  const isFix = (g: Json) => /transcri[cç][aã]o escreve/i.test(String(g.significado))
  const used = (g: Json) => {
    const term = plainText(String(g.termo ?? '').split(/[/(]/)[0])
    return term.length > 1 && taskText.includes(` ${term} `)
  }
  const all = list(geral?.glossario)
  const extra = all.filter(g => !isFix(g) && used(g)).slice(0, Math.max(0, 18 - all.filter(isFix).length))
  const gloss = all.filter(g => isFix(g) || extra.includes(g))
  if (gloss.length) parts.push('### Glossário', '', ...gloss.map(g => `- **${oneLine(g.termo)}:** ${oneLine(g.significado)}`), '')
  return { markdown: parts.join('\n').trim() + '\n', title, prints }
}

export async function buildTasks(m: Material, ctx: Context, ai: AtaAi, look: LookFn | null, onProgress: (message: string) => void = () => {}): Promise<TasksResult> {
  const said = saidIn(m.recording.blocks.map(block => block.text))
  onProgress('Tarefas: achando as candidatas trecho a trecho')
  const cands = await findCandidates(m, ctx, ai)
  onProgress(`Tarefas: juntando e revisando ${cands.length} candidatas`)
  const plan = await mergeAndReview(m, ctx, ai, cands, said)
  onProgress(`Tarefas: conferindo ${plan.tasks.length} tarefas com as falas e a tela`)
  const tasks = await verifyTasks(m, ctx, ai, plan, look, said)
  onProgress(`Tarefas: escrevendo ${tasks.length} tarefas e o que ficou sem dono`)
  const { bodies, geral, pending } = await writeTasks(m, ctx, ai, tasks)
  const done = assembleTasks(ctx, tasks, bodies, geral, unowned(pending, bodies, said))
  return { ...done, tasks, dropped: plan.dropped }
}
