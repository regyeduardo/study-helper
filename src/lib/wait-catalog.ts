/**
 * The Inventory of waits (spec 007, FR-061; contracts/ui.md): every wait the person sees, with where it shows, what a part is, the base
 * of its estimate and how long a step normally goes without moving. The tests and the screens read from here, so a wait that is not in
 * this list fails the inventory test (src/test/feedback/waits-inventory.test.tsx).
 */

export type WaitBasis = 'parts' | 'history' | 'parts+history' | 'queue'

export interface WaitEntry {
  id: string
  /** The wait, in the person's words. */
  label: string
  /** Where it shows. */
  where: string
  /** What a part is ("itens", "bytes", "pedaços"). */
  unit: string
  basis: WaitBasis
  /** How long a step normally goes without moving; null where the wait shows a queue position instead. */
  normalStepMs: number | null
}

const s = (seconds: number) => seconds * 1000
const min = (minutes: number) => minutes * 60_000

export const WAIT_CATALOG: readonly WaitEntry[] = [
  { id: 'abrir-biblioteca', label: 'Abrir a biblioteca (aparelho novo)', where: 'Tela "Abrindo a sua biblioteca…"', unit: 'itens recebidos', basis: 'parts', normalStepMs: s(10) },
  { id: 'entrar', label: 'Entrar na conta', where: 'Botão e tela de entrar', unit: 'etapas', basis: 'history', normalStepMs: s(10) },
  { id: 'lote', label: 'Mover, apagar, restaurar, esvaziar a Lixeira (em lote)', where: 'Janela do meio', unit: 'itens', basis: 'parts', normalStepMs: s(15) },
  { id: 'importar-exportar', label: 'Importar e exportar', where: 'Janela do meio', unit: 'itens e bytes', basis: 'parts', normalStepMs: s(30) },
  { id: 'locais', label: 'Levar para o App e trazer de volta (Locais)', where: 'Janela do meio', unit: 'itens e bytes', basis: 'parts', normalStepMs: s(30) },
  { id: 'estrutura', label: 'Ligar e desligar a estrutura do app', where: 'Janela do meio', unit: 'etapas e itens', basis: 'parts', normalStepMs: s(30) },
  { id: 'migracao', label: 'Migrações de dados (hierarquia, entradas)', where: 'Janela do meio', unit: 'itens', basis: 'parts', normalStepMs: s(30) },
  { id: 'enviar-midia', label: 'Enviar mídia ao App', where: 'Barra do envio e janela', unit: 'bytes', basis: 'parts', normalStepMs: s(60) },
  { id: 'baixar-midia', label: 'Baixar mídia', where: 'Barra do download', unit: 'bytes', basis: 'parts', normalStepMs: s(60) },
  { id: 'salvar-gravacao', label: 'Salvar uma gravação', where: 'Janela de gravação', unit: 'etapas e bytes', basis: 'parts', normalStepMs: s(30) },
  { id: 'transcrever', label: 'Transcrever', where: 'Gerações', unit: 'pedaços de 5 min', basis: 'parts+history', normalStepMs: min(3) },
  { id: 'ler-tela', label: 'Ler a tela de um vídeo', where: 'Gerações', unit: 'quadros', basis: 'parts+history', normalStepMs: min(1) },
  { id: 'gerar-nota', label: 'Ata, Aula, Explicação, Leitura', where: 'Gerações', unit: 'etapas e pedaços', basis: 'parts+history', normalStepMs: min(2) },
  { id: 'gerar-artefato', label: 'Mapa mental, cartões, Prova, curso', where: 'Gerações', unit: 'etapas', basis: 'history', normalStepMs: min(2) },
  { id: 'cartoes-idiomas', label: 'Cartões de Idiomas', where: 'Idiomas e Gerações', unit: 'cartões', basis: 'parts', normalStepMs: min(1) },
  { id: 'conversa', label: 'Resposta do Chat e do Tutor', where: 'Na conversa', unit: 'etapas (lendo, escrevendo)', basis: 'history', normalStepMs: s(60) },
  { id: 'youtube', label: 'Legenda de um vídeo do YouTube', where: 'Janela de nova nota', unit: 'etapas', basis: 'history', normalStepMs: s(30) },
  { id: 'ler-link-pdf', label: 'Ler um link ou um PDF', where: 'Janela de nova nota', unit: 'páginas', basis: 'parts', normalStepMs: s(30) },
  { id: 'fila', label: 'Fila de trabalhos', where: 'Gerações', unit: 'posição na fila', basis: 'queue', normalStepMs: null },
  { id: 'esperando-midia', label: 'Esperando a mídia subir (trabalho)', where: 'Gerações', unit: 'bytes', basis: 'parts', normalStepMs: s(60) },
  { id: 'compartilhar-copia', label: 'Compartilhar (cópia com mídia)', where: 'Janela Compartilhar', unit: 'bytes', basis: 'parts', normalStepMs: s(60) },
  { id: 'atualizar-copia', label: '"Atualizar" a cópia', where: 'Janela Compartilhar', unit: 'etapas', basis: 'history', normalStepMs: s(30) },
  { id: 'abrir-link', label: 'Abrir um link compartilhado', where: 'Página do link', unit: 'partes do conteúdo', basis: 'parts', normalStepMs: s(10) },
  { id: 'importar-link', label: 'Importar um link', where: 'Janela do meio', unit: 'itens e bytes', basis: 'parts', normalStepMs: s(30) },
  { id: 'liberar-espaco', label: 'Liberar espaço (cada ação)', where: 'Janela do meio', unit: 'itens e bytes', basis: 'parts', normalStepMs: s(30) },
  { id: 'subir-fila', label: 'Subir o que esperava sem internet', where: 'Pé da lateral', unit: 'notas', basis: 'parts', normalStepMs: s(30) },
  { id: 'sincronizar', label: 'Sincronizar (Local para Drive ou App)', where: 'Janela do meio', unit: 'itens e bytes', basis: 'parts', normalStepMs: s(30) },
  { id: 'medir', label: 'Medir (painel de medidas)', where: 'Painel', unit: 'operações', basis: 'parts', normalStepMs: s(30) },
]

export function waitEntry(id: string): WaitEntry {
  const entry = WAIT_CATALOG.find(item => item.id === id)
  if (!entry) throw new Error(`Espera fora do inventário: ${id}. Acrescente-a em contracts/ui.md e em src/lib/wait-catalog.ts.`)
  return entry
}
