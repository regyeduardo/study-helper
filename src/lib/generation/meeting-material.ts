/* eslint-disable @typescript-eslint/no-explicit-any */
// What every part of the Ata reads: meeting data, the speech with real names, the screen reading
// grouped by screen, and the context + glossary pass (pass 1 of relatorio.md).
import type { RecordingData } from '@/types/domain'
import type { AtaAi } from '@/lib/generation/ata-ai'
import * as P from '@/lib/generation/ata-prompts'
import { MICROPHONE } from '@/lib/transcription/turns'

export type Json = Record<string, any>

export const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function secs(mmss: unknown): number {
  const m = /(\d{1,3}):(\d{2})/.exec(String(mmss ?? ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN
}

export const short = (s: unknown, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

export const plainText = (x: string) =>
  x
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** JSON out of a model answer: drops <think>, code fences, and closes a JSON cut by max_tokens. */
export function jsonIn(text: string): Json | null {
  const t = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/```json|```/g, '')
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start < 0) return null
  try {
    const parsed = JSON.parse(t.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return salvage(t.slice(start))
  }
}

function salvage(t: string): Json | null {
  for (let cut = t.length; cut > 1; cut = t.lastIndexOf(',', cut - 1)) {
    const head = t.slice(0, cut)
    const stack: string[] = []
    let inString = false
    let escaped = false
    for (const ch of head) {
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') stack.push('}')
      else if (ch === '[') stack.push(']')
      else if (ch === '}' || ch === ']') stack.pop()
    }
    if (!inString) {
      try {
        return JSON.parse(head + stack.reverse().join(''))
      } catch {
        /* try a shorter cut */
      }
    }
    if (cut <= 0) break
  }
  return null
}

export async function pool<T, R>(items: T[], size: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        out[index] = await run(items[index], index)
      }
    }),
  )
  return out
}

export const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [])
export const oneLine = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()

// ---------------- speech ----------------

export interface Speech {
  at: number
  end: number
  who: string
  text: string
}

const NOISE = /^(\s*(tchau|obrigad[oa]|amém|e aí|hum+|boa noite|até mais|♪[^♪]*)[.,!?…]*\s*)+$/i
const DAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
const date = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`

export interface ScreenGroup {
  at: number
  end: number
  ats: number[]
  tela: string
  resumo: string
  text: string
}

export interface Material {
  recording: RecordingData
  people: string[]
  recorder: string | null
  participants: string
  dados: string
  blocks: Speech[]
  falas: string
  falasEntre(a: number, z: number): string
  screen: ScreenGroup[]
  tela: string
  telaEntre(a: number, z: number): string
  telaJanelas(moments: number[]): string
  catalogo: string
  catalogoCurto: string
  end: number
}

const span = (g: { at: number; end: number }) => (g.end - g.at >= 2 ? `${clock(g.at)}–${clock(g.end)}` : clock(g.at))

export function meetingMaterial(recording: RecordingData, startedAt: Date, screen: ScreenGroup[]): Material {
  const nameOf = (id: string) => recording.speakers.find(speaker => speaker.id === id)?.name ?? id
  const blocks = recording.blocks.filter(block => block.text.trim() && !NOISE.test(block.text.trim())).map(block => ({ at: block.start, end: block.end, who: block.speaker ? nameOf(block.speaker) : '?', text: block.text.trim() }))
  const people = [...new Set(blocks.map(block => block.who))].filter(name => name !== '?')
  const recorder = recording.blocks.some(block => block.speaker === MICROPHONE) ? nameOf(MICROPHONE) : null
  const ordered = [...people.filter(name => name !== recorder), ...(recorder && people.includes(recorder) ? [recorder] : [])]
  const role = (name: string) => (name === recorder ? `${name} (gravou)` : name)
  const participants = ordered.length > 1 ? `${ordered.slice(0, -1).map(role).join(', ')} e ${role(ordered[ordered.length - 1])}` : ordered.map(role).join('')
  const end = Math.max(0, ...recording.blocks.map(block => block.end))
  const calendar = Array.from({ length: 15 }, (_, i) => {
    const d = new Date(startedAt)
    d.setDate(d.getDate() + i)
    return `${DAYS[d.getDay()]} ${date(d)}${i === 0 ? ' (dia da reunião)' : i === 1 ? ' (amanhã)' : ''}`
  }).join('; ')
  const hour = `${String(startedAt.getHours()).padStart(2, '0')}:${String(startedAt.getMinutes()).padStart(2, '0')}`
  const dados = `DADOS DA REUNIÃO: ${date(startedAt)} (${DAYS[startedAt.getDay()]}), ${hour}, ${Math.max(1, Math.round(end / 60))} min. Participantes: ${participants || 'não identificados'}. Calendário: ${calendar}.`
  const line = (b: Speech) => `${clock(b.at)} | ${b.who}: ${b.text}`
  const falasEntre = (a: number, z: number) =>
    blocks
      .filter(b => b.end >= a && b.at <= z)
      .map(line)
      .join('\n')
  const screenLine = (g: ScreenGroup) => `${span(g)} | ${g.text}`
  const tela = screen.length ? screen.map(screenLine).join('\n') : fallbackScreen(recording)
  return {
    recording,
    people,
    recorder,
    participants,
    dados,
    blocks,
    falas: blocks.map(line).join('\n'),
    falasEntre,
    screen,
    tela,
    telaEntre: (a, z) =>
      screen
        .filter(s => s.end >= a && s.at <= z)
        .map(screenLine)
        .join('\n'),
    telaJanelas: moments =>
      screen
        .filter(s => moments.some(m => s.end >= m - 60 && s.at <= m + 20))
        .map(screenLine)
        .join('\n'),
    catalogo: screen.map(s => `${span(s)} | ${s.tela} — ${s.resumo}`).join('\n'),
    catalogoCurto: screen.map(s => `${span(s)} | ${s.tela}`).join('\n'),
    end,
  }
}

/** Without a fresh screen reading, the text the transcription step already read from the screen. */
function fallbackScreen(recording: RecordingData): string {
  return (recording.frames ?? []).map(frame => `${clock(frame.at)} | tela: ${short(frame.text, 400)}`).join('\n') || 'Sem leitura da tela.'
}

// ---------------- screen readings -> one line per screen ----------------

export interface Reading {
  at: number
  leitura: Json | null
}

function screenText(l: Json): string {
  if (!l || l.erro || l.vazio) return ''
  const parts = [short(l.programa, 40), short(l.tela, 60), l.caminho ? short(l.caminho, 80) : '', l.endereco ? short(l.endereco, 70) : '']
  if (l.cartao && (l.cartao.titulo || l.cartao.numero)) {
    const c = l.cartao
    parts.push(
      `CARTÃO ${c.numero ?? ''} "${short(c.titulo, 80)}" · responsáveis: ${(c.responsaveis ?? []).join(', ')} · início ${c.inicio ?? ''} · prazo ${c.prazo ?? ''} · status ${c.status ?? ''} · homologação/revisor ${c.revisor_ou_homologacao ?? ''} · descrição: ${short(c.descricao, 300)}`,
    )
  }
  if (Array.isArray(l.secoes) && l.secoes.length) parts.push(`seções: ${short(l.secoes.join('; '), 200)}`)
  if (Array.isArray(l.campos) && l.campos.length)
    parts.push(
      `campos: ${short(
        l.campos
          .filter((c: Json) => c && c.valor !== '' && c.valor != null)
          .map((c: Json) => `${c.rotulo}=${c.valor}`)
          .join('; '),
        700,
      )}`,
    )
  if (Array.isArray(l.lista) && l.lista.length) parts.push(`lista: ${short(l.lista.join(' | '), 300)}`)
  if (Array.isArray(l.botoes_e_abas) && l.botoes_e_abas.length) parts.push(`abas/botões: ${short(l.botoes_e_abas.join(', '), 160)}`)
  return parts.filter(Boolean).join(' · ')
}

const norm = (x: unknown) =>
  String(x ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, '')

/** Groups consecutive readings of the same screen (same address + title + card number); latest values win. */
export function groupReadings(readings: Reading[]): ScreenGroup[] {
  const groups: { key: string; at: number; end: number; ats: number[]; l: Json; campos: Map<string, string>; resumo: string }[] = []
  for (const r of [...readings].sort((a, b) => a.at - b.at)) {
    const l = r.leitura
    if (!l || l.erro || l.vazio || !screenText(l)) continue
    const key = `${norm(l.endereco).slice(0, 60)}|${norm(l.tela).slice(0, 40)}|${norm(l.cartao?.numero)}`
    let g = groups[groups.length - 1]
    if (!g || g.key !== key) {
      g = { key, at: r.at, end: r.at, ats: [], l: { ...l, campos: [], secoes: [], lista: [], botoes_e_abas: [] }, campos: new Map(), resumo: short(l.resumo, 140) }
      groups.push(g)
    }
    g.end = r.at
    g.ats.push(r.at)
    for (const c of list(l.campos)) if (c.rotulo && c.valor !== '' && c.valor != null) g.campos.set(String(c.rotulo), String(c.valor))
    for (const k of ['secoes', 'lista', 'botoes_e_abas']) for (const v of Array.isArray(l[k]) ? l[k] : []) if (!g.l[k].includes(v)) g.l[k].push(v)
    if (l.cartao && (l.cartao.titulo || l.cartao.numero)) g.l.cartao = l.cartao
    for (const k of ['programa', 'endereco', 'tela', 'caminho']) if (l[k]) g.l[k] = l[k]
  }
  return groups.map(g => ({
    at: g.at,
    end: g.end,
    ats: g.ats,
    tela: short(g.l.tela, 60),
    resumo: g.resumo,
    text: screenText({ ...g.l, campos: [...g.campos].slice(0, 45).map(([rotulo, valor]) => ({ rotulo, valor })), lista: g.l.lista.slice(0, 25), secoes: g.l.secoes.slice(0, 20) }),
  }))
}

// ---------------- pass 1: context + glossary ----------------

export interface Context {
  brief: Json
  /** Full context (candidates, merge, BASE parts). */
  contexto: string
  /** Short context (review, verify). */
  contextoCurto: string
  /** Glossary with only the misheard forms that really occur in the speech. */
  glossario: string
  /** Context for the general writer, with the filtered glossary. */
  contextoGeral: string
}

export async function understandMeeting(m: Material, ai: AtaAi): Promise<Context> {
  const brief = jsonIn(await ai.text('context', P.ENTENDER, `${m.dados}\n\nFALAS:\n${m.falas}\n\nLEITURA DA TELA:\n${m.tela}`, { max: 8000, json: true })) ?? {}
  return contextOf(brief, m)
}

export function contextOf(brief: Json, m: Material): Context {
  const pessoas = list(brief.pessoas)
  const glossario = list(brief.glossario)
  const people = pessoas.map(p => `${p.nome} (${p.papel ?? ''}${p.participou === false ? ', não participou' : ''})`).join('; ')
  const contexto = [
    'CONTEXTO:',
    `Assunto: ${brief.assunto ?? ''}`,
    String(brief.contexto ?? ''),
    `Pessoas: ${people}`,
    `Telas: ${list(brief.telas)
      .map(t => `${t.nome} [${t.caminho ?? ''}] ${t.o_que_tem ?? ''} (${(Array.isArray(t.momentos) ? t.momentos : []).join(', ')})`)
      .join('\n  ')}`,
    `Cartões: ${list(brief.cartoes)
      .map(c => `${c.numero} "${c.titulo}" resp. ${(Array.isArray(c.responsaveis) ? c.responsaveis : []).join(', ')} prazo ${c.prazo ?? ''} — ${c.descricao ?? ''} (${c.momento ?? ''})`)
      .join('\n  ')}`,
    `Glossário: ${glossario.map(g => `${g.termo}${Array.isArray(g.ouvido_como) && g.ouvido_como.length ? ` (ouvido: ${g.ouvido_como.join(', ')})` : ''}: ${g.significado ?? ''}`).join('\n  ')}`,
    `Erros de leitura da tela: ${
      list(brief.erros_de_leitura_da_tela)
        .map(e => `${e.lido} → ${e.certo}`)
        .join('; ') || 'nenhum'
    }`,
  ].join('\n')
  const contextoCurto = [
    'CONTEXTO:',
    `Assunto: ${brief.assunto ?? ''}`,
    String(brief.contexto ?? ''),
    `Pessoas: ${people}`,
    `Cartões: ${list(brief.cartoes)
      .map(c => `${c.numero} "${c.titulo}" resp. ${(Array.isArray(c.responsaveis) ? c.responsaveis : []).join(', ')} prazo ${c.prazo ?? ''} (${c.momento ?? ''})`)
      .join('; ')}`,
    `Glossário: ${glossario.map(g => `${g.termo}${Array.isArray(g.ouvido_como) && g.ouvido_como.length ? ` (ouvido: ${g.ouvido_como.join(', ')})` : ''}`).join('; ')}`,
  ].join('\n')
  const heardText = ` ${plainText(m.falas)} `
  const heard = (g: Json) => (Array.isArray(g.ouvido_como) ? g.ouvido_como : []).filter((o: string) => plainText(String(o)) && plainText(String(o)) !== plainText(String(g.termo ?? '')) && heardText.includes(` ${plainText(String(o))} `))
  const glossarioTexto = glossario.map(g => `- ${g.termo}${heard(g).length ? ` (a transcrição escreve: ${heard(g).join(', ')})` : ''}: ${g.significado ?? ''}`).join('\n')
  const contextoGeral = [
    'CONTEXTO:',
    `Assunto: ${brief.assunto ?? ''}`,
    String(brief.contexto ?? ''),
    `Pessoas: ${pessoas
      .filter(p => p.participou !== false || m.falas.includes(String(p.nome ?? '').split(' ')[0]))
      .map(p => `${p.nome} (${p.papel ?? ''})`)
      .join('; ')}`,
    `GLOSSÁRIO (com o que a transcrição escreveu errado):\n${glossarioTexto}`,
  ].join('\n')
  return { brief, contexto, contextoCurto, glossario: glossarioTexto, contextoGeral }
}

/** "Natalia Lenza" read on a card becomes "Natália Lenza" when that is a known name. */
export function accentNames(doc: string, names: string[]): string {
  const strip = (x: string) => x.normalize('NFD').replace(/\p{M}/gu, '')
  let out = doc
  for (const name of [...new Set(names)].filter(n => n && strip(n) !== n)) out = out.replace(new RegExp(`\\b${strip(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), name)
  return out
}

/** Turns "[▸ mm:ss]" (one or several times inside) into links the note's player understands. */
export function linkMoments(s: string): string {
  return s.replace(/\[▸\s*([^\]]+)\](?!\()/g, (_x, inner: string) =>
    [...String(inner).matchAll(/(\d{1,3}):(\d{2})/g)].map(found => `[▸ ${found[1].padStart(2, '0')}:${found[2]}](#t=${Number(found[1]) * 60 + Number(found[2])})`).join(' ') || _x,
  )
}

