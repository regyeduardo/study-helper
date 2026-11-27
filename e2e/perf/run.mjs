#!/usr/bin/env node
// The measures of spec 007 (research R1, R9), from the repository root: `npm run perf -- <options>`.
//   --perfil computador --perfil celular   profiles to measure (default: computador)
//   --rodadas 5                            rounds of each operation
//   --so abrir-pasta,buscar                only these operations
//   --saida <file.json>                    where the summary goes (default: specs/.../medidas/ultima.json)
//   --comparar <antes.json> <depois.json>  writes medidas-desempenho.md with both side by side
//   --guarda                               measures and fails if a median is more than 20% worse than medidas/referencia.json
// Small libraries for a quick look: PERF_NOTAS, PERF_TRANSCRICOES, PERF_MIDIAS, PERF_MIDIA_LONGA_S.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const spec = path.join(root, 'specs/007-desempenho-gerar-compartilhar')
const medidasDir = path.join(spec, 'medidas')

// targets of SC-001 and contracts/ui.md, in ms
export const METAS = {
  'abrir-app-cache': 2000, 'abrir-app-novo': 10000, entrar: 3000, 'tela-biblioteca': 500, 'tela-gravacoes': 500, 'tela-geracoes': 500, 'tela-idiomas': 500,
  'tela-config': 500, 'tela-admin': 500, 'abrir-pasta': 500, 'abrir-nota-texto': 1000, 'abrir-nota-midia': 1000, 'abrir-nota-pdf': 1000, digitar: 50,
  'guardar-texto': 1000, criar: 1000, renomear: 1000, mover: 1000, apagar: 1000, restaurar: 1000, buscar: 1000, 'abrir-locais': 2000, 'levar-para-app': 100,
  'enviar-midia': 100, 'tocar-midia': 3000, 'pular-minuto': 2000, 'abrir-cartoes': 1000, 'revisar-cartao': 100, 'abrir-prova': 1000, 'responder-prova': 100,
  'abrir-idiomas': 1000, 'revisar-idiomas': 100, 'pedir-geracao': 1000, 'salvar-gravacao': 2000, compartilhar: 10000, 'abrir-link': 2000, 'importar-link': 100,
  'mudanca-outro-aparelho': 10000,
}

function args(argv) {
  const out = { perfis: [], rodadas: '5', so: '', saida: '', comparar: null, guarda: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--perfil') out.perfis.push(argv[++i])
    else if (a === '--rodadas') out.rodadas = argv[++i]
    else if (a === '--so') out.so = argv[++i]
    else if (a === '--saida') out.saida = argv[++i]
    else if (a === '--comparar') out.comparar = [argv[++i], argv[++i]]
    else if (a === '--guarda') out.guarda = true
    else throw new Error(`opção desconhecida: ${a}`)
  }
  if (!out.perfis.length) out.perfis = ['computador']
  return out
}

const sorted = list => [...list].sort((a, b) => a - b)
const median = list => {
  const s = sorted(list)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const p95 = list => {
  const s = sorted(list)
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]
}

export function resumir(raw) {
  const groups = new Map()
  for (const r of raw.resultados) {
    const key = `${r.perfil}|${r.op}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  const linhas = []
  for (const [key, list] of groups) {
    const [perfil, op] = key.split('|')
    const ms = list.map(r => r.ms)
    linhas.push({
      op, perfil, rodadas: list.length,
      mediana_ms: Math.round(median(ms)), p95_ms: Math.round(p95(ms)),
      rede_ms: Math.round(median(list.map(r => r.rede))), servidor_ms: Math.round(median(list.map(r => r.servidor))),
      aparelho_ms: Math.round(median(list.map(r => r.aparelho))), pedidos: Math.round(median(list.map(r => r.pedidos))),
      meta_ms: METAS[op] ?? null,
    })
  }
  linhas.sort((a, b) => a.perfil.localeCompare(b.perfil) || a.op.localeCompare(b.op))
  return { quando: raw.quando, rodadas: raw.rodadas, linhas, falhas: raw.falhas }
}

function medirAgora(opts) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'estudo-perf-'))
  const rawFile = path.join(dir, 'bruto.json')
  const result = spawnSync(path.join(root, 'e2e/node_modules/.bin/playwright'), ['test', '-c', 'playwright.perf.config.ts'], {
    cwd: path.join(root, 'e2e'),
    stdio: 'inherit',
    env: { ...process.env, E2E_DIR: dir, PERF_PERFIS: opts.perfis.join(','), PERF_RODADAS: opts.rodadas, PERF_SO: opts.so, PERF_SAIDA: rawFile },
  })
  if (!existsSync(rawFile)) throw new Error(`as medidas não terminaram (saída ${result.status})`)
  return resumir(JSON.parse(readFileSync(rawFile, 'utf8')))
}

const fmt = ms => (ms === null || ms === undefined ? '—' : ms >= 1000 ? `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} s` : `${ms} ms`)

export function comparar(antes, depois) {
  const key = l => `${l.perfil}|${l.op}`
  const after = new Map(depois.linhas.map(l => [key(l), l]))
  const rows = antes.linhas.map(a => {
    const d = after.get(key(a))
    const ganho = d ? (a.mediana_ms / Math.max(1, d.mediana_ms)).toFixed(1) : '—'
    const meta = a.meta_ms ? (d ? (d.p95_ms <= a.meta_ms ? 'dentro' : 'fora') : '—') : '—'
    return `| ${a.op} | ${a.perfil} | ${fmt(a.mediana_ms)} | ${fmt(d?.mediana_ms)} | ${ganho}× | ${fmt(a.meta_ms)} | ${meta} | ${d ? `${fmt(d.rede_ms)} / ${fmt(d.servidor_ms)} / ${fmt(d.aparelho_ms)}` : '—'} |`
  })
  return [
    '# Medidas de desempenho (spec 007)',
    '',
    `Antes: ${antes.quando}. Depois: ${depois.quando}. Mediana de ${depois.rodadas} rodadas; "meta" confere o pior de 95% de depois.`,
    '',
    '| Operação | Perfil | Antes | Depois | Ganho | Meta | Depois na meta? | Depois: rede / servidor / aparelho |',
    '|----------|--------|-------|--------|-------|------|-----------------|------------------------------------|',
    ...rows,
    '',
  ].join('\n')
}

export function guarda(referencia, agora) {
  const ref = new Map(referencia.linhas.map(l => [`${l.perfil}|${l.op}`, l]))
  const piores = []
  for (const l of agora.linhas) {
    const r = ref.get(`${l.perfil}|${l.op}`)
    if (r && l.mediana_ms > r.mediana_ms * 1.2 && l.mediana_ms - r.mediana_ms > 20) piores.push(`${l.op} (${l.perfil}): ${fmt(r.mediana_ms)} → ${fmt(l.mediana_ms)}`)
  }
  return piores
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const opts = args(process.argv.slice(2))
  if (opts.comparar) {
    const [a, b] = opts.comparar.map(file => JSON.parse(readFileSync(path.isAbsolute(file) ? file : path.join(medidasDir, file), 'utf8')))
    writeFileSync(path.join(spec, 'medidas-desempenho.md'), comparar(a, b))
    console.log(`escrito ${path.join(spec, 'medidas-desempenho.md')}`)
  } else {
    const summary = medirAgora(opts)
    const saida = opts.saida ? path.resolve(root, opts.saida) : path.join(medidasDir, 'ultima.json')
    writeFileSync(saida, JSON.stringify(summary, null, 2))
    for (const l of summary.linhas) console.log(`${l.perfil.padEnd(11)} ${l.op.padEnd(24)} mediana ${fmt(l.mediana_ms).padStart(9)}  p95 ${fmt(l.p95_ms).padStart(9)}  meta ${fmt(l.meta_ms).padStart(7)}  rede ${fmt(l.rede_ms)} · servidor ${fmt(l.servidor_ms)} · aparelho ${fmt(l.aparelho_ms)}`)
    for (const f of summary.falhas) console.log(`FALHOU ${f.perfil} ${f.op} rodada ${f.rodada}: ${f.erro}`)
    console.log(`resumo em ${saida}`)
    if (opts.guarda) {
      const refFile = path.join(medidasDir, 'referencia.json')
      if (!existsSync(refFile)) throw new Error('sem medidas/referencia.json para a guarda')
      const piores = guarda(JSON.parse(readFileSync(refFile, 'utf8')), summary)
      if (piores.length) {
        console.error(`PIOROU mais de 20%:\n  ${piores.join('\n  ')}`)
        process.exit(1)
      }
      console.log('guarda: nenhuma operação piorou mais de 20%')
    }
  }
}
