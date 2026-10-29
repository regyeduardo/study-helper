import type { AiPassModels } from '@/types/domain'
import { useLibraryStore } from '@/stores/library'

export const PASS_DEFAULTS = {
  context: 'deepseek-ai/DeepSeek-V4-Pro',
  candidates: 'deepseek-ai/DeepSeek-V4-Pro',
  review: 'deepseek-ai/DeepSeek-V4.1-Flash',
  pending: 'Qwen/Qwen3.7-Max',
  write: 'deepseek-ai/DeepSeek-V4.1-Flash',
  vision: 'XiaomiMiMo/MiMo-V2.6-Flash',
}

const PASSES: [keyof AiPassModels, string][] = [
  ['context', 'Contexto e glossário'],
  ['candidates', 'Achar e juntar as tarefas'],
  ['review', 'Revisar a lista de tarefas'],
  ['pending', 'Achar o que ficou sem dono'],
  ['write', 'Verificar e escrever (Resumo e demais partes)'],
]

export function PassModels() {
  const passes = useLibraryStore(state => state.index.settings.aiPasses) ?? {}
  const updateSettings = useLibraryStore(state => state.updateSettings)
  const setPass = (key: keyof AiPassModels, value: string) => {
    const rest = Object.fromEntries(Object.entries(passes).filter(([id]) => id !== key)) as AiPassModels
    const model = value.trim()
    void updateSettings({ aiPasses: model ? { ...rest, [key]: model } : rest })
  }
  return (
    <details className="field">
      <summary>Avançado: modelo por passo</summary>
      <span className="faint" style={{ fontSize: 12 }}>
        Gerar a Ata usa a IA desta aba. Aqui dá para trocar o modelo de cada passo, no mesmo provedor e com a mesma chave. Vazio = o modelo acima.
      </span>
      {PASSES.map(([key, label]) => (
        <div className="field" key={key}>
          <label htmlFor={`pass-${key}`}>{label}</label>
          <input className="input" id={`pass-${key}`} autoComplete="off" placeholder={`vazio = modelo da aba Geral · recomendado: ${PASS_DEFAULTS[key]}`} value={passes[key] ?? ''} onChange={event => setPass(key, event.target.value)} />
        </div>
      ))}
      <span className="faint" style={{ fontSize: 12 }}>
        A visão (ler a tela, quem fala, prints) usa a aba Visão; recomendado: {PASS_DEFAULTS.vision}.
      </span>
    </details>
  )
}
