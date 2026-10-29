// Single-pass parts of the Ata (BASE + the part's prompt, from modelos.ts): Resumo, Perguntas em
// aberto, Linha do tempo and 1:1. They read the same material and the context/glossary of pass 1.
import type { AtaPart } from '@/types/domain'
import type { AtaAi } from '@/lib/generation/ata-ai'
import * as P from '@/lib/generation/ata-prompts'
import type { Context, Material } from '@/lib/generation/meeting-material'
import type { PrintRequest } from '@/lib/generation/tasks'

export type BasePart = Exclude<AtaPart, 'tarefas'>

export const PART_PROMPTS: Record<BasePart, string> = { resumo: P.RESUMO, perguntas: P.PERGUNTAS, linha: P.LINHA_DO_TEMPO, 'um-a-um': P.UM_A_UM }

const PRINT = /\{\{\s*print\s+(\d{1,3}):(\d{2})\s*\|\s*([^}]+?)\s*\}\}/g
const MAX_PRINTS = 5

export interface PartResult {
  /** Body with headings starting at "###"; prints as "{{img:NAME}}" lines. */
  markdown: string
  title: string
  prints: PrintRequest[]
}

/** "# T" becomes the title; "## X" becomes "### X" so the part fits under its own "## <Parte>". */
export function shapePart(raw: string, part: string): PartResult {
  let title = ''
  const prints: PrintRequest[] = []
  const lines = raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^```(markdown)?\s*$/gm, '')
    .split('\n')
    .filter(line => !/^>\s*Encaixe:/i.test(line))
  const out: string[] = []
  for (const line of lines) {
    const heading = /^(#{1,5})\s+(.*)$/.exec(line)
    if (heading && heading[1].length === 1) {
      if (!title) title = heading[2].trim()
      continue
    }
    out.push(heading ? `${'#'.repeat(Math.min(6, heading[1].length + 1))} ${heading[2]}` : line)
  }
  const body = out
    .join('\n')
    .replace(PRINT, (_all, mm: string, ss: string, what: string) => {
      if (prints.length >= MAX_PRINTS) return ''
      const name = `${part}-${prints.length + 1}.jpg`
      prints.push({ name, at: Number(mm) * 60 + Number(ss), marcar: what.trim(), legenda: what.trim() })
      return `{{img:${name}}}`
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { markdown: body + '\n', title, prints }
}

export async function writePart(part: BasePart, m: Material, ctx: Context, ai: AtaAi): Promise<PartResult> {
  const system = `${P.BASE}\n\n${PART_PROMPTS[part]}`
  const user = `${m.dados}\n\n${ctx.contextoGeral}\n\nFALAS:\n${m.falas}\n\nLEITURA DA TELA:\n${m.tela}`
  return shapePart(await ai.text('write', system, user, { max: 6000, json: false }), part)
}
