// 25/11 ("Bug horrível. Um fala que tá gerando outro não e que já está pronto"): a Explicação pedida com a nota no App é escrita pela
// conta; a página da nota só olhava o que roda neste aparelho e dizia "Esta aula ainda não foi escrita" com "Gerar agora" enquanto a conta
// escrevia. Agora a página mostra o trabalho da conta que escreve aquela nota: a nova que uma chamada devolveu (Explicar, Gerar desta
// nota) ou a própria nota (Gerar agora, Gerar de novo), com a etapa e o Cancelar.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type { AccountJob } from '@/controllers/jobs.controller'
import { DocumentBody } from '@/components/reader/DocumentArticle'
import { paths } from '@/lib/paths'
import { useAccountJobsStore } from '@/stores/account-jobs'
import { useLibraryStore } from '@/stores/library'
import { studyLibrary } from '@/test/generation/study-fixture'

const job = (fields: Partial<AccountJob>): AccountJob => ({
  id: 'conta-1', call: 'explainSelection', kind: 'generation', fileId: 'aula', title: 'Explicação · Aula', state: 'running', queuePosition: null, stage: 'Escrevendo a explicação',
  fraction: 0.4, etaAt: null, etaBasis: null, lastProgress: null, lastProgressAt: null, stalledSince: null, args: [], result: null, error: null, errorCode: null, attempt: 1,
  createdAt: '2026-11-25T22:52:16Z', startedAt: '2026-11-25T22:52:16Z', finishedAt: null, ...fields,
})

afterEach(() => {
  cleanup()
  useAccountJobsStore.setState({ jobs: [] })
  vi.unstubAllGlobals()
})

const library = () => useLibraryStore.getState()

async function explanation() {
  studyLibrary()
  const aula = await library().createFile({ name: 'Aula: gRPC', type: 'class', status: 'ready', folderId: null }, '# gRPC\n\nO handshake abre a conexão.')
  return library().createFile({ name: 'Explicação: handshake', type: 'explanation', status: 'generating', folderId: null, parentFileId: aula.id, sourceExcerpt: 'handshake' }, '')
}

function show(fileId: string) {
  render(
    <MemoryRouter initialEntries={[paths.file(fileId)]}>
      <DocumentBody fileId={fileId} />
    </MemoryRouter>,
  )
}

describe('a nota que a conta está escrevendo', () => {
  it('a Explicação devolvida pela conta: a etapa e o Cancelar, sem "Gerar agora" nem "não foi escrita"', async () => {
    const note = await explanation()
    const cancel = vi.fn(async () => undefined)
    useAccountJobsStore.setState({ jobs: [job({ result: note.id })], cancel })
    show(note.id)
    expect(await screen.findByRole('status')).toHaveTextContent('Escrevendo a explicação')
    expect(screen.queryByText(/não foi escrita|A geração não terminou/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Gerar agora|Tentar de novo/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(cancel).toHaveBeenCalledWith('conta-1')
  })

  it('na fila da conta: diz que está na fila', async () => {
    const note = await explanation()
    useAccountJobsStore.setState({ jobs: [job({ state: 'queued', queuePosition: 2, stage: null, startedAt: null, result: note.id })] })
    show(note.id)
    expect(await screen.findByRole('status')).toHaveTextContent('Na fila da conta (2º)')
  })

  it('"Gerar agora" pedido à conta: a própria nota mostra que está sendo escrita', async () => {
    const note = await explanation()
    useAccountJobsStore.setState({ jobs: [job({ id: 'conta-2', call: 'generatePending', fileId: note.id, stage: 'Escrevendo a aula' })] })
    show(note.id)
    expect(await screen.findByRole('status')).toHaveTextContent('Escrevendo a aula')
    expect(screen.queryByRole('button', { name: /Gerar agora|Tentar de novo/ })).not.toBeInTheDocument()
  })

  it('a nota de onde a Explicação saiu não mostra a escrita da filha como se fosse dela', async () => {
    const note = await explanation()
    useAccountJobsStore.setState({ jobs: [job({ result: note.id })] })
    show(note.parentFileId!)
    // the text of the note is drawn inside the viewer's own root
    await waitFor(() => expect(document.querySelector('[data-testid="github-viewer"]')?.shadowRoot?.textContent).toContain('abre a conexão'))
    expect(document.querySelector('.reader-live')).toBeNull()
  })
})
