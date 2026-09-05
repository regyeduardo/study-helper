import { useState } from 'react'

interface YoutubeUrlInputProps {
  value: string
  onChange: (url: string) => void
  onValidChange?: (isValid: boolean) => void
}

export default function YoutubeUrlInput({ value, onChange, onValidChange }: YoutubeUrlInputProps) {
  const [error, setError] = useState<string | null>(null)

  const validate = (url: string) => {
    const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/|shorts\/|live\/)|youtu\.be\/)[a-zA-Z0-9_-]{11}/
    const valid = url === '' || youtubeRegex.test(url)
    setError(valid ? null : 'Apenas links do YouTube são aceitos')
    onValidChange?.(valid)
    return valid
  }

  const handleChange = (url: string) => {
    onChange(url)
    if (url) validate(url)
    else setError(null)
  }

  return (
    <div className="mt-3">
      <input
        type="text"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="https://youtu.be/... (apenas YouTube)"
        className={`w-full px-4 py-2.5 rounded-xl bg-white/5 border text-sm text-white placeholder-slate-500 outline-none transition-all duration-200 ${
          error ? 'border-red-400 focus:border-red-400' : 'border-white/10 focus:border-violet-400'
        }`}
      />
      {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
    </div>
  )
}
