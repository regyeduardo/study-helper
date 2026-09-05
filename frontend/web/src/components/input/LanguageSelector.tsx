import { Globe } from 'lucide-react'

interface LanguageSelectorProps {
  value: string
  onChange: (lang: string) => void
  visible: boolean
}

const languages = [
  { value: '', label: 'Detecção automática 🌍' },
  { value: 'pt', label: 'Português 🇧🇷' },
  { value: 'en', label: 'Inglês 🇺🇸' },
  { value: 'es', label: 'Espanhol 🇪🇸' },
  { value: 'fr', label: 'Francês 🇫🇷' },
  { value: 'de', label: 'Alemão 🇩🇪' },
  { value: 'it', label: 'Italiano 🇮🇹' },
  { value: 'ja', label: 'Japonês 🇯🇵' },
  { value: 'ko', label: 'Coreano 🇰🇷' },
  { value: 'zh', label: 'Chinês 🇨🇳' },
  { value: 'ar', label: 'Árabe 🇸🇦' },
  { value: 'ru', label: 'Russo 🇷🇺' },
  { value: 'nl', label: 'Holandês 🇳🇱' },
  { value: 'pl', label: 'Polonês 🇵🇱' },
  { value: 'sv', label: 'Sueco 🇸🇪' },
  { value: 'da', label: 'Dinamarquês 🇩🇰' },
  { value: 'no', label: 'Norueguês 🇳🇴' },
  { value: 'fi', label: 'Finlandês 🇫🇮' },
  { value: 'tr', label: 'Turco 🇹🇷' },
  { value: 'hi', label: 'Hindi 🇮🇳' },
  { value: 'th', label: 'Tailandês 🇹🇭' },
  { value: 'vi', label: 'Vietnamita 🇻🇳' },
]

export default function LanguageSelector({ value, onChange, visible }: LanguageSelectorProps) {
  if (!visible) return null

  return (
    <div className="space-y-1.5">
      <label htmlFor="media-language" className="flex items-center gap-2 text-xs font-medium text-slate-400">
        <Globe size={12} />
        Idioma da mídia
      </label>
      <select
        id="media-language"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-emerald-400/60 transition-colors motion-reduce:transition-none"
      >
        {languages.map((lang) => (
          <option key={lang.value} value={lang.value} className="bg-slate-800">
            {lang.label}
          </option>
        ))}
      </select>
    </div>
  )
}
