import { BookOpen } from 'lucide-react'
import MarkdownViewer from '@/components/output/MarkdownViewer'
import { useAppState } from '@/context/AppContext'

export default function ReadingViewer() {
  const { generatedMarkdown } = useAppState()

  if (!generatedMarkdown) {
    return (
      <div className="text-center py-12 text-slate-500">
        <BookOpen size={36} className="mx-auto mb-2 text-slate-600" />
        <p className="text-sm">Abra um arquivo de leitura para começar.</p>
      </div>
    )
  }

  return <MarkdownViewer markdown={generatedMarkdown} />
}
