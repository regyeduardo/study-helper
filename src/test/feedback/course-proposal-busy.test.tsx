import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { CourseProposalDialog } from '@/components/dialogs/MoreDialogs'
import { type CourseProposal, useJobsStore } from '@/stores/jobs'
import { deferred, settle, slowLibrary } from '@/test/feedback/slow'

// "Criar a pasta com as aulas" makes a folder per module and a note per lesson: many writes. The clicked button says so.

let accepting: ReturnType<typeof deferred<string>>
let declining: ReturnType<typeof deferred<string>>
let accepted: number
let declined: number

const proposal = {
  analysis: { isCourse: true, name: 'Cálculo', description: 'Limites e derivadas.', lessonCount: 3, modules: [{ title: 'Limites', lessons: [] }] },
  request: { agent: 'lesson', input: { kind: 'topic', topic: 'Cálculo' }, name: 'Cálculo', description: '', folderId: null, prompt: '', storage: 'none', litterboxTime: '72h' },
  resolved: { content: 'x', title: 'Cálculo', description: '', origin: { input: 'topic', name: 'Cálculo', storage: 'none' }, transcription: null },
} as unknown as CourseProposal

beforeEach(() => {
  slowLibrary()
  accepting = deferred<string>()
  declining = deferred<string>()
  accepted = 0
  declined = 0
  useJobsStore.setState({
    proposals: [proposal],
    acceptCourse: () => {
      accepted++
      return accepting.promise
    },
    declineCourse: () => {
      declined++
      return declining.promise
    },
  })
})

const open = () =>
  render(
    <MemoryRouter>
      <CourseProposalDialog />
    </MemoryRouter>,
  )

describe('Proposta de curso: o botão clicado diz o que está fazendo', () => {
  it('"Criar a pasta com as aulas" vira "Criando as aulas…" e os dois botões se desligam', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Criar a pasta com as aulas' }))
    const busy = screen.getByRole('button', { name: /Criando as aulas/ })
    expect(busy).toBeDisabled()
    expect(busy.querySelector('.spinning')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Não, uma aula só' })).toBeDisabled()
    expect(accepted).toBe(1)
  })

  it('"Não, uma aula só" vira "Criando a aula…" e o outro botão continua desligado', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Não, uma aula só' }))
    expect(screen.getByRole('button', { name: /Criando a aula/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Criar a pasta com as aulas' })).toBeDisabled()
    expect(declined).toBe(1)
  })

  it('o clique repetido não cria a pasta duas vezes', () => {
    open()
    const button = screen.getByRole('button', { name: 'Criar a pasta com as aulas' })
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('button', { name: /Criando as aulas/ }))
    expect(accepted).toBe(1)
  })

  it('se não deu certo, os botões voltam e o motivo aparece', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Criar a pasta com as aulas' }))
    await act(async () => {
      accepting.reject(new Error('Sem espaço no Drive'))
      await settle()
    })
    expect(screen.getByRole('button', { name: 'Criar a pasta com as aulas' })).toBeEnabled()
    expect(screen.getByText('Sem espaço no Drive')).toBeInTheDocument()
  })
})
