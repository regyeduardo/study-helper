import { useRef, useState } from 'react'
import { FileCheck2, UploadCloud } from 'lucide-react'

interface FileUploadProps {
  onFile: (file: File) => void
  accept?: string
}

export default function FileUpload({ onFile, accept }: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setFileName(file.name)
      onFile(file)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) {
      setFileName(file.name)
      onFile(file)
    }
  }

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-all duration-200 ${
          dragOver
            ? 'border-violet-400 bg-violet-500/10'
            : 'border-white/10 hover:border-violet-400/50 bg-white/5'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          onChange={handleChange}
          className="hidden"
        />
        {fileName ? (
          <div className="flex items-center justify-center gap-2 text-sm font-medium text-violet-300">
            <FileCheck2 size={18} />
            {fileName}
          </div>
        ) : (
          <div className="text-sm text-slate-400">
            <UploadCloud size={22} className="mx-auto mb-1.5 text-slate-500" />
            <span className="font-medium text-slate-300">Clique para selecionar</span>
            <br />
            ou arraste um arquivo aqui
          </div>
        )}
      </div>
    </div>
  )
}
