import { useCallback, useEffect, useState } from 'react'
import {
  ArrowLeft, ChevronDown, ChevronRight, ClipboardList, Clock, Eye, FileText, Folder, FolderPlus,
  GraduationCap, Home, Info, MoreVertical, Pencil, RotateCcw, Sparkles, Trash2, X,
} from 'lucide-react'
import { api } from '@/api/client'
import { getStorageItem, setStorageItem } from '@/lib/utils'
import type { FileItem, FolderItem, QuestionsResponse, TempFileItem, TreeNode } from '@/types'

interface FileManagerPageProps {
  onClose: () => void
  onSelectFile: (file: FileItem, folderId: string | null, folderName: string | null) => void
  onExplainFromLesson?: (file: FileItem) => void
  /** Called after a file is deleted, so the parent can drop it if it was the open document. */
  onDeleteFile?: (fileId: string) => void
  onStartExam?: (questions: QuestionsResponse) => void
  onStartFolderExam?: (folder: FolderItem) => void
  openFileId?: string | null
}

const TIPOS = [
  { valor: 'class', rotulo: 'Aula', emoji: '🎓', cor: 'bg-violet-500/20 text-violet-300 border-violet-500/30' },
  { valor: 'explanation', rotulo: 'Explicação', emoji: '💡', cor: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  { valor: 'meeting', rotulo: 'Reunião', emoji: '🎙', cor: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  { valor: 'reading', rotulo: 'Leitura', emoji: '📖', cor: 'bg-sky-500/20 text-sky-300 border-sky-500/30' },
] as const

function etiqueta(tipo: string | null | undefined) {
  const encontrado = TIPOS.find(t => t.valor === tipo)
  if (!encontrado) return null
  return (
    <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${encontrado.cor}`}>
      {encontrado.emoji} {encontrado.rotulo}
    </span>
  )
}

/** Depth-first search for a folder, used to resolve the selected node's children. */
function acharPasta(nodes: TreeNode[], id: string): FolderItem | null {
  for (const node of nodes) {
    if (node.kind !== 'folder') continue
    if (node.id === id) return node
    const dentro = acharPasta(node.children, id)
    if (dentro) return dentro
  }
  return null
}

/** True if candidateId sits anywhere inside ancestorId's subtree — moving a folder into its own descendant would create a cycle. */
function ehDescendente(ancestorId: string, candidateId: string, nodes: TreeNode[]): boolean {
  const pasta = acharPasta(nodes, ancestorId)
  if (!pasta) return false
  const contem = (n: TreeNode[], alvo: string): boolean => {
    for (const item of n) {
      if (item.id === alvo) return true
      if (item.kind === 'folder' && contem(item.children, alvo)) return true
    }
    return false
  }
  return contem(pasta.children, candidateId)
}

/** Name of a folder given its id, so "Voltar" can label the parent it steps up to. */
function nomeDaPasta(nodes: TreeNode[], id: string | null): string {
  if (id === null) return 'Raiz'
  return acharPasta(nodes, id)?.name ?? 'Raiz'
}

/** The left sidebar: the folder hierarchy, one row per folder, expandable. */
function Arvore({
  nodes,
  atual,
  expandidas,
  onNavegar,
  onExpandir,
  nivel = 0,
  pastaDragOver,
  onFolderDragEnter,
  onFolderDragOver,
  onFolderDragLeave,
  onFolderDrop,
}: {
  nodes: TreeNode[]
  atual: string | null
  expandidas: Set<string>
  onNavegar: (id: string | null, nome: string) => void
  onExpandir: (id: string) => void
  nivel?: number
  pastaDragOver: string | null
  onFolderDragEnter: (e: React.DragEvent, folder: FolderItem) => void
  onFolderDragOver: (e: React.DragEvent) => void
  onFolderDragLeave: (e: React.DragEvent) => void
  onFolderDrop: (e: React.DragEvent, folder: FolderItem) => void
}) {
  const pastas = nodes.filter((n): n is FolderItem => n.kind === 'folder')
  if (pastas.length === 0) return null

  return (
    <ul className="space-y-0.5">
      {pastas.map(pasta => {
        const temFilhas = pasta.children.some(c => c.kind === 'folder')
        const aberta = expandidas.has(pasta.id)
        return (
          <li key={pasta.id}>
            <div
              onDragEnter={e => onFolderDragEnter(e, pasta)}
              onDragOver={onFolderDragOver}
              onDragLeave={onFolderDragLeave}
              onDrop={e => onFolderDrop(e, pasta)}
              className={`flex items-center gap-1 rounded-lg pr-2 ${
                pastaDragOver === pasta.id
                  ? 'bg-violet-500/25 ring-1 ring-violet-500/50'
                  : atual === pasta.id ? 'bg-violet-500/15 text-violet-200' : 'text-slate-300 hover:bg-white/5'
              }`}
              style={{ paddingLeft: `${nivel * 12 + 4}px` }}
            >
              <button
                onClick={() => onExpandir(pasta.id)}
                className="p-1 text-slate-500 hover:text-slate-300 shrink-0"
                aria-label={aberta ? 'Recolher' : 'Expandir'}
              >
                {temFilhas
                  ? aberta ? <ChevronDown size={13} /> : <ChevronRight size={13} />
                  : <span className="inline-block w-[13px]" />}
              </button>
              <button
                onClick={() => onNavegar(pasta.id, pasta.name)}
                className="flex-1 flex items-center gap-1.5 py-1.5 text-left text-xs truncate"
              >
                <Folder size={13} className="text-cyan-400 shrink-0" />
                <span className="truncate">{pasta.name}</span>
              </button>
            </div>
            {aberta && (
              <Arvore
                nodes={pasta.children}
                atual={atual}
                expandidas={expandidas}
                onNavegar={onNavegar}
                onExpandir={onExpandir}
                nivel={nivel + 1}
                pastaDragOver={pastaDragOver}
                onFolderDragEnter={onFolderDragEnter}
                onFolderDragOver={onFolderDragOver}
                onFolderDragLeave={onFolderDragLeave}
                onFolderDrop={onFolderDrop}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}

export default function FileManagerPage({
  onClose, onSelectFile, onExplainFromLesson, onDeleteFile, onStartExam, onStartFolderExam, openFileId,
}: FileManagerPageProps) {
  const [tree, setTree] = useState<TreeNode[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState('')
  const [pastaAtual, setPastaAtual] = useState<string | null>(null)
  const [nomeAtual, setNomeAtual] = useState('Raiz')
  const [expandidas, setExpandidas] = useState<Set<string>>(new Set())
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set())
  const [renomeando, setRenomeando] = useState<string | null>(null)
  const [nomeEditado, setNomeEditado] = useState('')
  const [menu, setMenu] = useState<{ node: TreeNode; x: number; y: number } | null>(null)
  const [confirmandoApagar, setConfirmandoApagar] = useState(false)
  const [operando, setOperando] = useState<string | null>(null)
  const [editandoDescricao, setEditandoDescricao] = useState<FileItem | null>(null)
  const [descricaoTexto, setDescricaoTexto] = useState('')

  // Clicar e arrastar pra mover — itensArrastados guarda os nodes (não só ids) porque o
  // drop pode acontecer numa pasta que não está mais em "visiveis" (ex.: na árvore lateral).
  const [itensArrastados, setItensArrastados] = useState<TreeNode[]>([])
  const [pastaDragOver, setPastaDragOver] = useState<string | null>(null)

  // "Temporários" is not a real folder in the tree — it is a virtual root entry over
  // the generated-but-never-saved files, so they stop being invisible in the manager.
  const [verTemporarios, setVerTemporarios] = useState(false)
  const [temporarios, setTemporarios] = useState<TempFileItem[]>([])
  const [carregandoTemp, setCarregandoTemp] = useState(false)
  const [vendoConteudo, setVendoConteudo] = useState<TempFileItem | null>(null)
  const [restaurando, setRestaurando] = useState<TempFileItem | null>(null)
  const [nomeRestaurar, setNomeRestaurar] = useState('')
  const [pastaRestaurar, setPastaRestaurar] = useState<string | null>(null)
  const [pastasParaRestaurar, setPastasParaRestaurar] = useState<FolderItem[]>([])

  const carregarTemporarios = useCallback(async () => {
    setCarregandoTemp(true)
    try {
      setTemporarios(await api.getTempFiles())
    } catch (e: unknown) {
      setErro(`Não foi possível carregar os temporários: ${(e as Error).message}`)
    } finally {
      setCarregandoTemp(false)
    }
  }, [])

  const abrirTemporarios = () => {
    setVerTemporarios(true)
    carregarTemporarios()
  }

  const apagarTemporario = async (tf: TempFileItem) => {
    if (!confirm(`Apagar "${tf.name}" de vez?`)) return
    try {
      await api.deleteTempFile(tf.id)
      setTemporarios(prev => prev.filter(f => f.id !== tf.id))
    } catch (e: unknown) {
      setErro(`Não foi possível apagar: ${(e as Error).message}`)
    }
  }

  const abrirRestaurar = async (tf: TempFileItem) => {
    setRestaurando(tf)
    setNomeRestaurar(tf.name)
    setPastaRestaurar(null)
    try {
      setPastasParaRestaurar(await api.getFolders())
    } catch {
      setPastasParaRestaurar([])
    }
  }

  const confirmarRestaurar = async () => {
    if (!restaurando || !nomeRestaurar.trim()) return
    try {
      const { file_id } = await api.restoreTempFile(restaurando.id, {
        name: nomeRestaurar.trim(),
        folder_id: pastaRestaurar,
      })
      setTemporarios(prev => prev.filter(f => f.id !== restaurando.id))
      setRestaurando(null)
      const arquivo = await api.getFile(file_id)
      const pasta = pastaRestaurar ? pastasParaRestaurar.find(p => p.id === pastaRestaurar) : null
      onSelectFile(arquivo, pastaRestaurar, pasta?.name ?? null)
      onClose()
    } catch (e: unknown) {
      setErro(`Não foi possível restaurar: ${(e as Error).message}`)
    }
  }
  const [criandoPasta, setCriandoPasta] = useState(false)
  const [nomeNovaPasta, setNomeNovaPasta] = useState('')

  const [tiposFiltrados, setTiposFiltrados] = useState<string[]>(
    () => getStorageItem<string[]>('manager-tipos', []) ?? [],
  )
  const [ocultarPastas, setOcultarPastas] = useState(() => getStorageItem('manager-ocultar-pastas', false) ?? false)
  const [modoBloco, setModoBloco] = useState(() => getStorageItem('manager-modo-bloco', false) ?? false)

  const carregar = useCallback(async () => {
    setCarregando(true)
    setErro('')
    try {
      setTree(await api.getTree())
    } catch (e: unknown) {
      setErro(`Não foi possível carregar as pastas: ${(e as Error).message}`)
    } finally {
      setCarregando(false)
    }
  }, [])

  useEffect(() => { carregar() }, [carregar])

  const conteudo = pastaAtual ? (acharPasta(tree, pastaAtual)?.children ?? []) : tree
  // Parent of the current folder, so "Voltar" steps up one level instead of exiting.
  const paiId = pastaAtual ? (acharPasta(tree, pastaAtual)?.folder_id ?? null) : null
  const visiveis = conteudo.filter(node => {
    if (node.kind === 'folder') return !ocultarPastas
    if (tiposFiltrados.length === 0) return true
    return tiposFiltrados.includes((node as FileItem).type ?? '')
  })

  const alternarTipo = (tipo: string) => {
    const proximo = tiposFiltrados.includes(tipo)
      ? tiposFiltrados.filter(t => t !== tipo)
      : [...tiposFiltrados, tipo]
    setTiposFiltrados(proximo)
    setStorageItem('manager-tipos', proximo)
  }

  const abrir = (node: TreeNode) => {
    if (node.kind === 'folder') {
      setPastaAtual(node.id)
      setNomeAtual(node.name)
      setExpandidas(anterior => new Set(anterior).add(node.id))
      return
    }
    onSelectFile(node as FileItem, pastaAtual, pastaAtual ? nomeAtual : null)
  }

  const alternarSelecao = (id: string) => {
    setSelecionados(anterior => {
      const proximo = new Set(anterior)
      proximo.has(id) ? proximo.delete(id) : proximo.add(id)
      return proximo
    })
  }

  // --- Clicar e arrastar ---

  const iniciarArraste = (e: React.DragEvent, item: TreeNode) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', item.id)
    // Se o item arrastado já estava selecionado junto com outros, move o grupo inteiro.
    if (selecionados.has(item.id) && selecionados.size > 1) {
      setItensArrastados(visiveis.filter(n => selecionados.has(n.id)))
    } else {
      setItensArrastados([item])
    }
  }

  const terminarArraste = () => {
    setItensArrastados([])
    setPastaDragOver(null)
  }

  const podeSoltarEm = (pastaId: string) =>
    itensArrastados.length > 0 &&
    !itensArrastados.some(d => d.id === pastaId) &&
    !itensArrastados.some(d => d.kind === 'folder' && ehDescendente(d.id, pastaId, tree))

  const dragEnterPasta = (e: React.DragEvent, pasta: FolderItem) => {
    e.preventDefault()
    e.stopPropagation()
    if (podeSoltarEm(pasta.id)) setPastaDragOver(pasta.id)
  }

  const dragOverPasta = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  // Não limpa pastaDragOver aqui: ao passar por cima de um irmão, o dragEnter do novo
  // alvo já ajusta o destaque; limpar no dragLeave causa flicker (some as duas trocas).
  const dragLeavePasta = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const moverPara = async (destinoId: string | null) => {
    if (itensArrastados.length === 0) return
    setOperando('Movendo…')
    setErro('')
    try {
      const idsArquivos = itensArrastados.filter(d => d.kind === 'file').map(d => d.id)
      const pastas = itensArrastados.filter((d): d is FolderItem => d.kind === 'folder')
      if (idsArquivos.length > 0) await api.bulkMoveFiles(idsArquivos, destinoId)
      for (const p of pastas) await api.moveFolder(p.id, destinoId)
      setItensArrastados([])
      setSelecionados(new Set())
      await carregar()
    } catch (e: unknown) {
      setErro(`Não foi possível mover: ${(e as Error).message}`)
    } finally {
      setOperando(null)
    }
  }

  const soltarEmPasta = async (e: React.DragEvent, pasta: FolderItem) => {
    e.preventDefault()
    e.stopPropagation()
    setPastaDragOver(null)
    if (!podeSoltarEm(pasta.id)) return
    await moverPara(pasta.id)
  }

  const salvarNome = async (node: TreeNode) => {
    const nome = nomeEditado.trim()
    setRenomeando(null)
    if (!nome || nome === node.name) return
    try {
      if (node.kind === 'folder') await api.updateFolder(node.id, { name: nome })
      else await api.updateFile(node.id, { name: nome })
      await carregar()
    } catch (e: unknown) {
      setErro(`Não foi possível renomear: ${(e as Error).message}`)
    }
  }

  const apagar = async (nodes: TreeNode[]) => {
    setConfirmandoApagar(false)
    try {
      const arquivos = nodes.filter(n => n.kind !== 'folder').map(n => n.id)
      if (arquivos.length === 1) await api.deleteFile(arquivos[0])
      else if (arquivos.length > 1) await api.bulkDeleteFiles(arquivos)
      for (const pasta of nodes.filter(n => n.kind === 'folder')) await api.deleteFolder(pasta.id)
      // The parent keeps a document open independently of this list; without this it
      // stays pointed at an id that no longer exists, and saving or regenerating fails
      // with no clear explanation.
      for (const id of arquivos) onDeleteFile?.(id)
      setSelecionados(new Set())
      await carregar()
    } catch (e: unknown) {
      setErro(`Não foi possível apagar: ${(e as Error).message}`)
    }
  }

  const gerarQuestoes = async (file: FileItem) => {
    const jaTem = (file.questions_count ?? 0) > 0
    if (jaTem && !confirm(`"${file.name}" já tem ${file.questions_count} questão(ões). Substituir por novas?`)) return
    setOperando('Gerando questões…')
    try {
      const completo = await api.getFile(file.id)
      const titulo = completo.name.replace(/\.md$/i, '')
      const dados = await api.generateQuestions(completo.content, titulo, file.id)
      if (!dados.questions?.length) {
        setErro('Não foi possível gerar questões a partir deste arquivo.')
        return
      }
      await carregar()
    } catch (e: unknown) {
      setErro(`Não foi possível gerar questões: ${(e as Error).message}`)
    } finally {
      setOperando(null)
    }
  }

  const fazerProva = async (file: FileItem) => {
    if (!onStartExam) return
    setOperando('Preparando prova…')
    try {
      const dbQuestions = await api.getQuestions(file.id)
      if (dbQuestions.length === 0) {
        setErro('Nenhuma questão encontrada para este arquivo.')
        return
      }
      onStartExam({
        questions: dbQuestions.map((q, idx) => ({
          id: idx,
          enunciado: q.statement,
          alternativas: { A: q.alternative_a, B: q.alternative_b, C: q.alternative_c, D: q.alternative_d, E: q.alternative_e },
          correta: q.right_alternative,
          explicacao: q.explanation || '',
          diagrama: q.diagram || undefined,
        })),
      })
      onClose()
    } catch (e: unknown) {
      setErro(`Não foi possível carregar as questões: ${(e as Error).message}`)
    } finally {
      setOperando(null)
    }
  }

  const salvarDescricao = async () => {
    if (!editandoDescricao) return
    try {
      await api.updateFile(editandoDescricao.id, { description: descricaoTexto })
      setEditandoDescricao(null)
      await carregar()
    } catch (e: unknown) {
      setErro(`Não foi possível salvar a descrição: ${(e as Error).message}`)
    }
  }

  const criarPasta = async () => {
    const nome = nomeNovaPasta.trim()
    if (!nome) return
    try {
      await api.createFolder({ name: nome, folder_id: pastaAtual })
      setNomeNovaPasta('')
      setCriandoPasta(false)
      await carregar()
    } catch (e: unknown) {
      setErro(`Não foi possível criar a pasta: ${(e as Error).message}`)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[#0a0a0f]">
      <header className="flex items-center gap-3 px-5 py-3 border-b border-white/10 shrink-0">
        <button
          onClick={() => {
            if (verTemporarios) { setVerTemporarios(false); return }
            setPastaAtual(paiId); setNomeAtual(nomeDaPasta(tree, paiId))
          }}
          onDragEnter={e => {
            e.preventDefault(); e.stopPropagation()
            if (!verTemporarios && pastaAtual !== null && itensArrastados.length > 0) setPastaDragOver('__pai__')
          }}
          onDragOver={dragOverPasta}
          onDragLeave={dragLeavePasta}
          onDrop={e => { e.preventDefault(); setPastaDragOver(null); if (!verTemporarios && pastaAtual !== null) moverPara(paiId) }}
          disabled={!verTemporarios && pastaAtual === null}
          title="Subir uma pasta"
          className={`flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            pastaDragOver === '__pai__' ? 'bg-violet-500/25 border-violet-500/50' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
          }`}
        >
          <ArrowLeft size={14} /> Voltar
        </button>
        <button
          onClick={onClose}
          title="Fechar o gerenciador"
          className="p-2 rounded-lg bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 transition-colors"
        >
          <X size={14} />
        </button>
        <h1 className="text-sm font-semibold text-slate-200">Gerenciador de Arquivos</h1>
        <span className="text-xs text-slate-500">{verTemporarios ? 'Temporários' : nomeAtual}</span>
      </header>

      <div className="flex flex-1 min-h-0">
        <aside className="w-64 shrink-0 border-r border-white/10 overflow-y-auto p-3">
          <button
            onClick={() => { setVerTemporarios(false); setPastaAtual(null); setNomeAtual('Raiz') }}
            onDragEnter={e => {
              e.preventDefault(); e.stopPropagation()
              if (podeSoltarEm('__raiz__') && itensArrastados.length > 0) setPastaDragOver('__raiz__')
            }}
            onDragOver={dragOverPasta}
            onDragLeave={dragLeavePasta}
            onDrop={e => { e.preventDefault(); setPastaDragOver(null); moverPara(null) }}
            className={`w-full flex items-center gap-1.5 px-2 py-1.5 mb-1 rounded-lg text-xs ${
              pastaDragOver === '__raiz__'
                ? 'bg-violet-500/25 ring-1 ring-violet-500/50'
                : !verTemporarios && pastaAtual === null ? 'bg-violet-500/15 text-violet-200' : 'text-slate-300 hover:bg-white/5'
            }`}
          >
            <Home size={13} /> Raiz
          </button>
          <button
            onClick={abrirTemporarios}
            className={`w-full flex items-center gap-1.5 px-2 py-1.5 mb-1 rounded-lg text-xs ${
              verTemporarios ? 'bg-violet-500/15 text-violet-200' : 'text-slate-300 hover:bg-white/5'
            }`}
          >
            <Clock size={13} /> Temporários
          </button>
          <Arvore
            nodes={tree}
            atual={pastaAtual}
            expandidas={expandidas}
            onNavegar={(id, nome) => { setVerTemporarios(false); setPastaAtual(id); setNomeAtual(nome) }}
            onExpandir={id => setExpandidas(anterior => {
              const proximo = new Set(anterior)
              proximo.has(id) ? proximo.delete(id) : proximo.add(id)
              return proximo
            })}
            pastaDragOver={pastaDragOver}
            onFolderDragEnter={dragEnterPasta}
            onFolderDragOver={dragOverPasta}
            onFolderDragLeave={dragLeavePasta}
            onFolderDrop={soltarEmPasta}
          />
        </aside>

        <section className="flex-1 min-w-0 flex flex-col">
          <div className="flex flex-wrap items-center gap-1 px-5 py-2 border-b border-white/5 shrink-0">
            {TIPOS.map(({ valor, rotulo }) => (
              <button
                key={valor}
                onClick={() => alternarTipo(valor)}
                className={`px-2 py-1 text-[11px] rounded-lg border transition-colors ${
                  tiposFiltrados.includes(valor)
                    ? 'bg-violet-500/20 border-violet-500/40 text-violet-200'
                    : 'bg-white/5 border-white/10 text-slate-400 hover:text-slate-200'
                }`}
              >
                {rotulo}
              </button>
            ))}

            <div className="flex-1" />

            <button
              onClick={() => { setOcultarPastas(!ocultarPastas); setStorageItem('manager-ocultar-pastas', !ocultarPastas) }}
              className={`px-2 py-1 text-[11px] rounded-lg border transition-colors ${
                ocultarPastas
                  ? 'bg-amber-500/20 border-amber-500/40 text-amber-200'
                  : 'bg-white/5 border-white/10 text-slate-400 hover:text-slate-200'
              }`}
            >
              {ocultarPastas ? 'Mostrar pastas' : 'Ocultar pastas'}
            </button>
            <button
              onClick={() => { setModoBloco(!modoBloco); setStorageItem('manager-modo-bloco', !modoBloco) }}
              className="px-2 py-1 text-[11px] rounded-lg border bg-white/5 border-white/10 text-slate-400 hover:text-slate-200 transition-colors"
            >
              {modoBloco ? 'Lista' : 'Bloco'}
            </button>
            <button
              onClick={() => setCriandoPasta(true)}
              className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-lg border bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 transition-colors"
            >
              <FolderPlus size={13} /> Nova pasta
            </button>
          </div>

          {selecionados.size > 0 && (
            <div className="flex items-center gap-2 px-5 py-2 border-b border-white/5 bg-white/5 shrink-0">
              <span className="text-xs text-slate-300">{selecionados.size} selecionado(s)</span>
              <div className="flex-1" />
              {confirmandoApagar ? (
                <>
                  <span className="text-xs text-red-300">Apagar de vez?</span>
                  <button
                    onClick={() => apagar(visiveis.filter(n => selecionados.has(n.id)))}
                    className="px-3 py-1 text-xs rounded-lg bg-red-600 text-white hover:bg-red-500"
                  >
                    Apagar
                  </button>
                  <button
                    onClick={() => setConfirmandoApagar(false)}
                    className="px-3 py-1 text-xs rounded-lg bg-white/5 border border-white/10 text-slate-300"
                  >
                    Cancelar
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setConfirmandoApagar(true)}
                    className="flex items-center gap-1 px-3 py-1 text-xs rounded-lg bg-white/5 border border-white/10 text-red-300 hover:bg-red-500/10"
                  >
                    <Trash2 size={13} /> Apagar
                  </button>
                  <button
                    onClick={() => setSelecionados(new Set())}
                    className="px-3 py-1 text-xs rounded-lg bg-white/5 border border-white/10 text-slate-300"
                  >
                    Limpar seleção
                  </button>
                </>
              )}
            </div>
          )}

          {criandoPasta && (
            <div className="flex items-center gap-2 px-5 py-2 border-b border-white/5 shrink-0">
              <input
                autoFocus
                value={nomeNovaPasta}
                onChange={e => setNomeNovaPasta(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') criarPasta()
                  if (e.key === 'Escape') { setCriandoPasta(false); setNomeNovaPasta('') }
                }}
                placeholder="Nome da pasta"
                className="flex-1 max-w-xs bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white
                           placeholder:text-slate-600 focus:border-violet-500/60"
              />
              <button onClick={criarPasta} className="px-3 py-1.5 text-xs rounded-lg bg-violet-600 text-white hover:bg-violet-500">
                Criar
              </button>
            </div>
          )}

          <div data-testid="conteudo-pasta" className="flex-1 overflow-y-auto p-5">
            {erro && <p className="text-xs text-red-300 mb-3">{erro}</p>}
            {verTemporarios ? (
              carregandoTemp ? (
                <p className="text-xs text-slate-500">Carregando…</p>
              ) : temporarios.length === 0 ? (
                <p className="text-xs text-slate-500">Nenhum arquivo temporário — tudo que foi gerado já está salvo.</p>
              ) : (
                <ul className="space-y-0.5">
                  {temporarios.map(tf => (
                    <li key={tf.id} className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-white/5">
                      <FileText size={14} className="text-slate-400 shrink-0" />
                      <span className="flex-1 text-xs text-slate-200 truncate">{tf.name}</span>
                      {etiqueta(tf.type)}
                      <span className="text-[10px] text-slate-500 shrink-0">
                        {new Date(tf.created_at).toLocaleString('pt-BR')}
                      </span>
                      <button onClick={() => setVendoConteudo(tf)} title="Ver conteúdo" className="p-1 text-slate-500 hover:text-slate-200 shrink-0">
                        <Eye size={13} />
                      </button>
                      <button onClick={() => abrirRestaurar(tf)} title="Restaurar (salvar de vez)" className="p-1 text-slate-500 hover:text-emerald-400 shrink-0">
                        <RotateCcw size={13} />
                      </button>
                      <button onClick={() => apagarTemporario(tf)} title="Apagar" className="p-1 text-slate-500 hover:text-red-400 shrink-0">
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : carregando ? (
              <p className="text-xs text-slate-500">Carregando…</p>
            ) : visiveis.length === 0 ? (
              <p className="text-xs text-slate-500">
                {ocultarPastas || tiposFiltrados.length > 0
                  ? 'Nada aqui com os filtros atuais.'
                  : 'Esta pasta está vazia.'}
              </p>
            ) : modoBloco ? (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                {visiveis.map(node => (
                  <div
                    key={node.id}
                    draggable
                    onDragStart={e => iniciarArraste(e, node)}
                    onDragEnd={terminarArraste}
                    onDragEnter={node.kind === 'folder' ? e => dragEnterPasta(e, node as FolderItem) : undefined}
                    onDragOver={node.kind === 'folder' ? dragOverPasta : undefined}
                    onDragLeave={node.kind === 'folder' ? dragLeavePasta : undefined}
                    onDrop={node.kind === 'folder' ? e => soltarEmPasta(e, node as FolderItem) : undefined}
                    onContextMenu={e => { e.preventDefault(); setMenu({ node, x: e.clientX, y: e.clientY }) }}
                    className={`group relative flex flex-col gap-2 p-3 rounded-xl border transition-colors ${
                      pastaDragOver === node.id
                        ? 'bg-violet-500/25 border-violet-500/50 ring-1 ring-violet-500/50'
                        : node.id === openFileId
                        ? 'bg-violet-500/10 border-violet-500/40'
                        : 'bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20'
                    } ${itensArrastados.some(d => d.id === node.id) ? 'opacity-40' : ''}`}
                  >
                    <div className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={selecionados.has(node.id)}
                        onChange={() => alternarSelecao(node.id)}
                        aria-label={`Selecionar ${node.name}`}
                        className="shrink-0 accent-violet-500"
                      />
                      {node.kind === 'folder'
                        ? <Folder size={14} className="text-cyan-400 shrink-0" />
                        : <FileText size={14} className="text-slate-400 shrink-0" />}
                      {node.kind !== 'folder' && etiqueta((node as FileItem).type)}
                      <button
                        onClick={e => setMenu({ node, x: e.clientX, y: e.clientY })}
                        title="Mais ações"
                        className="ml-auto p-0.5 text-slate-500 hover:text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      >
                        <MoreVertical size={13} />
                      </button>
                    </div>
                    {renomeando === node.id ? (
                      <input
                        autoFocus
                        value={nomeEditado}
                        onChange={e => setNomeEditado(e.target.value)}
                        onBlur={() => salvarNome(node)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') salvarNome(node)
                          if (e.key === 'Escape') setRenomeando(null)
                        }}
                        className="bg-white/5 border border-violet-500/40 rounded px-2 py-1 text-xs text-white"
                      />
                    ) : (
                      <button onClick={() => abrir(node)} className="text-left">
                        <span className="text-xs text-slate-200 line-clamp-2">{node.name}</span>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <ul className="space-y-0.5">
                {visiveis.map(node => (
                  <li
                    key={node.id}
                    draggable
                    onDragStart={e => iniciarArraste(e, node)}
                    onDragEnd={terminarArraste}
                    onDragEnter={node.kind === 'folder' ? e => dragEnterPasta(e, node as FolderItem) : undefined}
                    onDragOver={node.kind === 'folder' ? dragOverPasta : undefined}
                    onDragLeave={node.kind === 'folder' ? dragLeavePasta : undefined}
                    onDrop={node.kind === 'folder' ? e => soltarEmPasta(e, node as FolderItem) : undefined}
                    onContextMenu={e => { e.preventDefault(); setMenu({ node, x: e.clientX, y: e.clientY }) }}
                    className={`group flex items-center gap-2 px-3 rounded-lg transition-colors ${
                      pastaDragOver === node.id
                        ? 'bg-violet-500/25 ring-1 ring-violet-500/50'
                        : node.id === openFileId ? 'bg-violet-500/10' : 'hover:bg-white/5'
                    } ${itensArrastados.some(d => d.id === node.id) ? 'opacity-40' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={selecionados.has(node.id)}
                      onChange={() => alternarSelecao(node.id)}
                      aria-label={`Selecionar ${node.name}`}
                      className="shrink-0 accent-violet-500"
                    />
                    {renomeando === node.id ? (
                      <input
                        autoFocus
                        value={nomeEditado}
                        onChange={e => setNomeEditado(e.target.value)}
                        onBlur={() => salvarNome(node)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') salvarNome(node)
                          if (e.key === 'Escape') setRenomeando(null)
                        }}
                        className="flex-1 bg-white/5 border border-violet-500/40 rounded px-2 py-1 text-xs text-white"
                      />
                    ) : (
                    <button onClick={() => abrir(node)} className="flex-1 flex items-center gap-2 py-2 text-left min-w-0">
                      {node.kind === 'folder'
                        ? <Folder size={14} className="text-cyan-400 shrink-0" />
                        : <FileText size={14} className="text-slate-400 shrink-0" />}
                      <span className="flex-1 text-xs text-slate-200 truncate">{node.name}</span>
                      {node.kind !== 'folder' && etiqueta((node as FileItem).type)}
                    </button>
                    )}
                    <button
                      onClick={() => { setRenomeando(node.id); setNomeEditado(node.name) }}
                      title="Renomear"
                      className="p-1 text-slate-500 hover:text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => apagar([node])}
                      title="Apagar"
                      className="p-1 text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                    >
                      <Trash2 size={13} />
                    </button>
                    {node.kind !== 'folder' && (node as FileItem).type === 'class' && onExplainFromLesson && (
                      <button
                        onClick={() => { onExplainFromLesson(node as FileItem); onClose() }}
                        title="Gerar Explicação"
                        className="p-1 text-slate-500 hover:text-violet-400 transition-colors shrink-0"
                      >
                        <Sparkles size={13} />
                      </button>
                    )}
                    <button
                      onClick={e => setMenu({ node, x: e.clientX, y: e.clientY })}
                      title="Mais ações"
                      className="p-1 text-slate-500 hover:text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                    >
                      <MoreVertical size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {operando && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-[#0d0d15] border border-white/10 text-xs text-violet-300 shadow-2xl">
          {operando}
        </div>
      )}

      {editandoDescricao && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md mx-4 rounded-2xl bg-[#0d0d15] border border-white/10 p-4">
            <h2 className="text-sm font-semibold text-slate-200 mb-2">Descrição — {editandoDescricao.name}</h2>
            <textarea
              autoFocus
              value={descricaoTexto}
              onChange={e => setDescricaoTexto(e.target.value)}
              rows={4}
              placeholder="Sem descrição"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white
                         placeholder:text-slate-600 focus:border-violet-500/60 resize-none"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setEditandoDescricao(null)}
                className="px-3 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-slate-300"
              >
                Cancelar
              </button>
              <button
                onClick={salvarDescricao}
                className="px-3 py-1.5 text-xs rounded-lg bg-violet-600 text-white hover:bg-violet-500"
              >
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      {vendoConteudo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-2xl max-h-[80vh] mx-4 flex flex-col rounded-2xl bg-[#0d0d15] border border-white/10 p-4">
            <div className="flex items-center justify-between mb-2 shrink-0">
              <h2 className="text-sm font-semibold text-slate-200 truncate">{vendoConteudo.name}</h2>
              <button onClick={() => setVendoConteudo(null)} className="p-1 text-slate-400 hover:text-white">
                <X size={16} />
              </button>
            </div>
            <pre className="flex-1 overflow-y-auto text-xs text-slate-300 whitespace-pre-wrap font-sans leading-relaxed">
              {vendoConteudo.content}
            </pre>
          </div>
        </div>
      )}

      {restaurando && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md mx-4 rounded-2xl bg-[#0d0d15] border border-white/10 p-4">
            <h2 className="text-sm font-semibold text-slate-200 mb-3">Restaurar — salvar de vez</h2>
            <label className="text-xs font-medium text-slate-400">Nome</label>
            <input
              autoFocus
              value={nomeRestaurar}
              onChange={e => setNomeRestaurar(e.target.value)}
              className="w-full mt-1 mb-3 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white
                         focus:border-violet-500/60"
            />
            <label className="text-xs font-medium text-slate-400">Pasta</label>
            <select
              value={pastaRestaurar ?? ''}
              onChange={e => setPastaRestaurar(e.target.value || null)}
              className="w-full mt-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white"
            >
              <option value="">Raiz</option>
              {pastasParaRestaurar.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setRestaurando(null)}
                className="px-3 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-slate-300"
              >
                Cancelar
              </button>
              <button
                onClick={confirmarRestaurar}
                disabled={!nomeRestaurar.trim()}
                className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                Restaurar
              </button>
            </div>
          </div>
        </div>
      )}

      {menu && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setMenu(null)} />
          <div
            className="fixed z-50 min-w-40 rounded-xl border border-white/10 bg-[#0d0d15] shadow-2xl shadow-black/50 overflow-hidden"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              onClick={() => { setRenomeando(menu.node.id); setNomeEditado(menu.node.name); setMenu(null) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-white/5 text-left"
            >
              <Pencil size={13} /> Renomear
            </button>
            {menu.node.kind === 'folder' ? (
              onStartFolderExam && (
                <button
                  onClick={() => { onStartFolderExam(menu.node as FolderItem); setMenu(null); onClose() }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-white/5 text-left"
                >
                  <ClipboardList size={13} /> Prova da pasta
                </button>
              )
            ) : (
              <>
                <button
                  onClick={() => { setEditandoDescricao(menu.node as FileItem); setDescricaoTexto((menu.node as FileItem).description || ''); setMenu(null) }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-white/5 text-left"
                >
                  <Info size={13} /> Descrição
                </button>
                <button
                  onClick={() => { gerarQuestoes(menu.node as FileItem); setMenu(null) }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-white/5 text-left"
                >
                  <GraduationCap size={13} /> Gerar questões
                </button>
                {((menu.node as FileItem).questions_count ?? 0) > 0 && onStartExam && (
                  <button
                    onClick={() => { fazerProva(menu.node as FileItem); setMenu(null) }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-white/5 text-left"
                  >
                    <ClipboardList size={13} /> Fazer prova
                  </button>
                )}
              </>
            )}
            <button
              onClick={() => { apagar([menu.node]); setMenu(null) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-300 hover:bg-red-500/10 text-left"
            >
              <Trash2 size={13} /> Apagar
            </button>
          </div>
        </>
      )}
    </div>
  )
}
