import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { File as NodeFile } from 'node:buffer'
import { MemoryRouter } from 'react-router-dom'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock('@/routes', () => ({ router: { navigate } }))

import { RecordingDoneDialog } from '@/components/dialogs/RecordDialogs'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useJobsStore } from '@/stores/jobs'
import { useRecorderStore } from '@/stores/recorder'
import { deferred, jobsNow, running, settle, slowLibrary } from '@/test/feedback/slow'

// "Salvar" of a finished recording closes the window and does several writes before the note opens.

let saving: ReturnType<typeof deferred<string>>
let saveCalls: number

beforeEach(() => {
  slowLibrary()
  saving = deferred<string>()
  saveCalls = 0
  navigate.mockClear()
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
  useJobsStore.setState({
    saveRecording: () => {
      saveCalls++
      return saving.promise
    },
  })
  const file = new NodeFile([new Uint8Array(8)], 'Reunião 14-10-2026, 09-00-00.webm', { type: 'audio/webm' }) as unknown as File
  useRecorderStore.setState({ result: { file, mime: 'audio/webm;codecs=opus', durationSeconds: 65, storedName: 'gravacao-1.webm', marks: [] }, resultPlace: 'dialog' })
})

const open = () =>
  render(
    <MemoryRouter>
      <RecordingDoneDialog />
    </MemoryRouter>,
  )

describe('Gravação pronta: "Salvar" mostra que está salvando', () => {
  it('no clique aparece "Salvando a gravação" no painel de tarefas, antes de qualquer gravação acabar', () => {
    open()
    fireEvent.click(screen.getByRole('radio', { name: /Só guardar/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(saveCalls).toBe(1)
    expect(running()).toHaveLength(1)
    expect(running()[0]).toMatchObject({ kind: 'sync', title: 'Salvando a gravação…' })
  })

  it('terminou: a linha sai do painel (a nota se abre) e a nota abre', async () => {
    open()
    fireEvent.click(screen.getByRole('radio', { name: /Só guardar/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await act(async () => {
      saving.resolve('nota-1')
      await settle()
    })
    expect(running()).toHaveLength(0)
    expect(navigate).toHaveBeenCalledWith('/arquivo/nota-1')
  })

  it('não salvou: a linha vira o erro, com o motivo', async () => {
    open()
    fireEvent.click(screen.getByRole('radio', { name: /Só guardar/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await act(async () => {
      saving.reject(new Error('Sem espaço no Drive'))
      await settle()
    })
    expect(running()).toHaveLength(0)
    expect(jobsNow()[0]).toMatchObject({ status: 'error', title: 'Salvando a gravação…', error: 'Sem espaço no Drive' })
    expect(navigate).not.toHaveBeenCalled()
  })
})
