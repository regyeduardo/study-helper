import { Plus, X } from 'lucide-react'
import { useTabs } from '@/context/AppContext'
import { getTitleFromMarkdown } from '@/lib/utils'

/** One document per tab, so generating or opening a second one no longer discards the first. */
export default function TabsBar() {
  const { order, byId, activeId, createTab, closeTab, switchTab } = useTabs()

  return (
    <div data-testid="tabs-bar" className="flex items-center gap-1 px-1 pb-2 overflow-x-auto">
      {order.map(id => {
        const tab = byId[id]
        const titulo = tab.savedFileName || getTitleFromMarkdown(tab.generatedMarkdown) || 'Novo conteúdo'
        const ativa = id === activeId
        return (
          <div
            key={id}
            onClick={() => switchTab(id)}
            className={`group flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-t-lg text-xs cursor-pointer
                        border-b-2 transition-colors shrink-0 max-w-50 ${
              ativa
                ? 'bg-white/5 border-violet-500 text-white'
                : 'bg-transparent border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            <span className="truncate">{titulo}</span>
            <button
              onClick={e => { e.stopPropagation(); closeTab(id) }}
              title="Fechar aba"
              className="p-0.5 rounded text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
      <button
        onClick={() => createTab()}
        title="Nova aba"
        className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-colors shrink-0"
      >
        <Plus size={14} />
      </button>
    </div>
  )
}
