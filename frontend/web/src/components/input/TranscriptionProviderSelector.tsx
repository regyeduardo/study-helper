import { Cloud, Cpu } from 'lucide-react'
import type { TranscriptionProvider } from '@/types'

interface TranscriptionProviderSelectorProps {
  value: TranscriptionProvider
  onChange: (provider: TranscriptionProvider) => void
  openaiAvailable?: boolean
  visible?: boolean
}

export default function TranscriptionProviderSelector({
  value,
  onChange,
  openaiAvailable = true,
  visible = true,
}: TranscriptionProviderSelectorProps) {
  if (!visible) return null

  return (
    <div className="space-y-1.5" data-testid="transcription-provider-selector">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <Cpu size={12} />
          Motor de transcrição
        </label>
        {!openaiAvailable && (
          <span className="text-[10px] text-amber-400/80 bg-amber-400/10 px-1.5 py-0.5 rounded">
            OpenAI requer OPENAI_API_KEY no .env
          </span>
        )}
      </div>

      <div
        role="radiogroup"
        aria-label="Motor de transcrição"
        className="grid grid-cols-2 gap-2 bg-white/5 p-1 rounded-xl border border-white/10"
      >
        <button
          type="button"
          role="radio"
          aria-checked={value === 'local'}
          data-testid="provider-option-local"
          onClick={() => onChange('local')}
          className={`flex items-center gap-2 p-2 rounded-lg text-xs font-medium transition-all ${
            value === 'local'
              ? 'bg-white/15 text-white shadow-sm border border-white/20'
              : 'text-slate-400 hover:text-white hover:bg-white/5 border border-transparent'
          }`}
        >
          <Cpu size={15} className="shrink-0 text-emerald-400" />
          <div className="text-left min-w-0">
            <div className="truncate font-semibold">Local (Whisper)</div>
            <div className="text-[10px] text-slate-400 truncate">No seu hardware</div>
          </div>
        </button>

        <button
          type="button"
          role="radio"
          aria-checked={value === 'openai'}
          data-testid="provider-option-openai"
          onClick={() => onChange('openai')}
          disabled={!openaiAvailable}
          className={`flex items-center gap-2 p-2 rounded-lg text-xs font-medium transition-all ${
            value === 'openai'
              ? 'bg-white/15 text-white shadow-sm border border-white/20'
              : !openaiAvailable
                ? 'opacity-50 cursor-not-allowed text-slate-500 border border-transparent'
                : 'text-slate-400 hover:text-white hover:bg-white/5 border border-transparent'
          }`}
        >
          <Cloud size={15} className="shrink-0 text-sky-400" />
          <div className="text-left min-w-0">
            <div className="truncate font-semibold">Nuvem (OpenAI)</div>
            <div className="text-[10px] text-slate-400 truncate">Rápido via API</div>
          </div>
        </button>
      </div>
    </div>
  )
}
