import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { ExplainDialog } from '@/components/dialogs/MoreDialogs'
import { Toasts } from '@/components/ui/Toasts'
import { useJobsStore } from '@/stores/jobs'
import { useUiStore } from '@/stores/ui'
import { deferred, settle, slowLibrary } from '@/test/feedback/slow'

// "Gerar explicação" reads the note and writes to the Drive before it can close: the button must answer at once.

let explain: ReturnType<typeof deferred<string>>
let calls: number

beforeEach(() => {
  slowLibrary()
  explain = deferred<string>()
  calls = 0
  useJobsStore.setState({
    explainSelection: () => {
      calls++
      return explain.promise
    },
  })
  useUiStore.setState({ overlay: { kind: 'explain', fileId: 'a', excerpt: 'laterais' } })
})

const open = () =>
  render(
    <MemoryRouter>
      <ExplainDialog fileId="a" excerpt="laterais" />
      <Toasts />
    </MemoryRouter>,
  )

describe('Explicar isto: o botão responde na hora', () => {
  it('no clique o botão vira "Gerando…" e fica desligado', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: /Gerar explicação/ }))
    const busy = screen.getByRole('button', { name: /Gerando/ })
    expect(busy).toBeDisabled()
    expect(busy.querySelector('.spinning')).not.toBeNull()
    // the text stays: she can see what is being explained
    expect(screen.getByText('laterais')).toBeInTheDocument()
  })

  it('dois cliques seguidos geram uma explicação só', () => {
    open()
    const button = screen.getByRole('button', { name: /Gerar explicação/ })
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('button', { name: /Gerando/ }))
    expect(calls).toBe(1)
  })

  it('quando o texto é criado a janela fecha e o aviso aparece', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: /Gerar explicação/ }))
    await act(async () => {
      explain.resolve('nova')
      await settle()
    })
    expect(useUiStore.getState().overlay).toBeNull()
    expect(screen.getByText('Gerando a explicação. Você pode continuar lendo.')).toBeInTheDocument()
  })

  it('se não deu para criar, o botão volta e o motivo aparece', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: /Gerar explicação/ }))
    await act(async () => {
      explain.reject(new Error('Arquivo de origem não encontrado.'))
      await settle()
    })
    expect(screen.getByRole('button', { name: /Gerar explicação/ })).toBeEnabled()
    expect(screen.getByText('Arquivo de origem não encontrado.')).toBeInTheDocument()
  })
})
