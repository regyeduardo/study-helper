import { useState } from 'react'

interface UrlInputProps {
  value: string
  onChange: (url: string) => void
  onValidChange?: (isValid: boolean) => void
}

export default function UrlInput({ value, onChange, onValidChange }: UrlInputProps) {
  const [error, setError] = useState<string | null>(null)

  const validate = (url: string) => {
    // Accept any http/https URL
    const urlRegex = /^https?:\/\/[^\s/$.?#].[^\s]*$/
    const valid = url === '' || urlRegex.test(url)
    setError(valid ? null : 'Insira uma URL válida (http:// ou https://)')
    onValidChange?.(valid)
    return valid
  }

  const handleChange = (url: string) => {
    onChange(url)
    if (url) validate(url)
    else setError(null)
  }

  return (
    <div>
      <input
        type="text"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="https://youtube.com/... ou https://exemplo.com/artigo"
        className={`w-full px-4 py-2.5 rounded-xl bg-white/5 border text-sm text-white placeholder-slate-500 outline-none transition-all duration-200 ${
          error ? 'border-red-400 focus:border-red-400' : 'border-white/10 focus:border-violet-400'
        }`}
      />
      {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
    </div>
  )
}
