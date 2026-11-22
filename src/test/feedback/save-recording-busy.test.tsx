import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { File as NodeFile } from 'node:buffer'
import { MemoryRouter } from 'react-router-dom'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock('@/routes', () => ({ router: { navigate } }))

import { RecordingDoneDialog } from '@/components/dialogs/RecordDialogs'
import { BlockingWindow } from '@/components/ui/BlockingWindow'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useBlockingStore } from '@/stores/blocking'
import { useJobsStore } from '@/stores/jobs'
import { useRecorderStore } from '@/stores/recorder'
import { deferred, jobsNow, settle, slowLibrary } from '@/test/feedback/slow'

// "Salvar" of a finished recording closes the window and does several writes before the note opens: the window that holds the app
// (owner's choice F) says so from the click until the note opens.

let saving: ReturnType<typeof deferred<string>>
let saveCalls: number

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  useBlockingStore.setState({ ops: [] })
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

afterEach(() => {
  vi.useRealTimers()
})

const open = () =>
  render(
    <MemoryRouter>
      <RecordingDoneDialog />
      <BlockingWindow />
    </MemoryRouter>,
  )

describe('Gravação pronta: "Salvar" mostra que está salvando', () => {
  it('no clique a janela "Salvando a gravação" segura o app, antes de qualquer gravação acabar', async () => {
    open()
    fireEvent.click(screen.getByRole('radio', { name: /Só guardar/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(saveCalls).toBe(1)
    expect(useBlockingStore.getState().ops).toMatchObject([{ title: 'Salvando a gravação…', phase: 'Guardando a gravação' }])
    await act(async () => vi.advanceTimersByTime(350))
    expect(screen.getByRole('alertdialog', { name: 'Salvando a gravação…' })).toHaveTextContent('Guardando a gravação')
    // the window, not a line in Tarefas
    expect(jobsNow()).toHaveLength(0)
  })

  it('terminou: a janela fecha e a nota abre', async () => {
    open()
    fireEvent.click(screen.getByRole('radio', { name: /Só guardar/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await act(async () => {
      saving.resolve('nota-1')
      await settle()
    })
    expect(useBlockingStore.getState().ops).toHaveLength(0)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(navigate).toHaveBeenCalledWith('/arquivo/nota-1')
  })

  it('não salvou: a janela fica com o motivo até "Fechar", e a nota não abre', async () => {
    open()
    fireEvent.click(screen.getByRole('radio', { name: /Só guardar/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await act(async () => {
      saving.reject(new Error('Sem espaço no Drive'))
      await settle()
    })
    const window_ = screen.getByRole('alertdialog', { name: 'Salvando a gravação…' })
    expect(window_).toHaveTextContent('Sem espaço no Drive')
    expect(navigate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
