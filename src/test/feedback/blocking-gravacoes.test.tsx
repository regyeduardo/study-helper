import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { File as NodeFile } from 'node:buffer'

import { RecordDialog, RecordingWindow } from '@/components/dialogs/RecordDialogs'
import { BlockingWindow } from '@/components/ui/BlockingWindow'
import { IntegrationCapture, useIntegrationStore } from '@/lib/recording/integration'
import { MeetingRecorder, type RecorderCallbacks } from '@/lib/recording/recorder'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useBlockingStore } from '@/stores/blocking'
import { useJobsStore } from '@/stores/jobs'
import { useRecorderStore } from '@/stores/recorder'
import { deferred, fileNow, jobsNow, settle, slowLibrary } from '@/test/feedback/slow'
import { installIntegration } from '@/test/recording/integration-fakes'
import { FakeMediaRecorder, installMediaEnvironment } from '@/test/recording/media-fakes'

// Escolha F do dono: "Começar a gravar", "Terminar", "Descartar" e o envio da mídia para o Drive seguram o app na janela
// do clique até o fim. O pedido do navegador (microfone, tela) continua saindo do clique: a janela é só do app.

const ops = () => useBlockingStore.getState().ops
// the store's own actions, back before each test (some tests put slow ones in their place)
const actions = useRecorderStore.getState()
const flush = () => act(async () => await settle())

const LIVE = { preview: null, meters: { microphone: null, computer: null }, computerAudio: 'som da aba', hasMicrophone: true, hasSource: true, microphoneOn: true, sourceOn: true, microphoneId: null, sourceChoice: 'display', paused: false, screenOn: true }

beforeEach(() => {
  installMediaEnvironment()
  installIntegration({ available: false })
  useIntegrationStore.setState({ status: 'unknown', hello: null })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
  useRecorderStore.setState({ ...actions, active: false, seconds: 0, mode: null, result: null, resultPlace: 'dialog', floating: null, live: null, error: null })
  useBlockingStore.setState({ ops: [] })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('"Começar a gravar"', () => {
  it('pede o microfone e a tela no clique, com "Começando a gravar…" segurando o app até a gravação começar', async () => {
    const starting = deferred()
    const start = vi.fn(() => starting.promise)
    useRecorderStore.setState({ start })
    const { container } = render(
      <>
        <RecordDialog />
        <BlockingWindow />
      </>,
    )
    fireEvent.click(await screen.findByRole('button', { name: /Começar a gravar/ }))
    await flush()
    // the browser's own request went out from the click; the app waits under the window
    expect(start).toHaveBeenCalledTimes(1)
    expect(ops()).toMatchObject([{ title: 'Começando a gravar…' }])
    expect(container).toHaveAttribute('inert')

    await act(async () => {
      starting.resolve()
      await settle()
    })
    expect(ops()).toHaveLength(0)
  })

  it('o navegador recusa: a janela fecha e o motivo aparece como antes', async () => {
    const starting = deferred()
    useRecorderStore.setState({ start: vi.fn(() => starting.promise) })
    render(
      <>
        <RecordDialog />
        <BlockingWindow />
      </>,
    )
    fireEvent.click(await screen.findByRole('button', { name: /Começar a gravar/ }))
    await flush()
    expect(ops()).toHaveLength(1)
    await act(async () => {
      starting.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
      await settle()
    })
    expect(ops()).toHaveLength(0)
    expect(await screen.findByRole('alert')).toHaveTextContent('Você não deu permissão para gravar.')
  })

  it('pela integração: "Começando a gravar…" até a gravação começar', async () => {
    installIntegration({ available: true, windows: [] })
    vi.spyOn(IntegrationCapture, 'start').mockImplementation(async source => ({ stop: vi.fn(async () => undefined), source, meters: { microphone: null, computer: null }, label: 'x' }) as unknown as IntegrationCapture)
    const starting = deferred()
    const startIntegration = vi.fn(() => starting.promise)
    useRecorderStore.setState({ startIntegration })
    render(
      <>
        <RecordDialog />
        <BlockingWindow />
      </>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Começar a gravar' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Começar a gravar' }))
    await flush()
    expect(startIntegration).toHaveBeenCalledTimes(1)
    expect(ops()).toMatchObject([{ title: 'Começando a gravar…' }])
    await act(async () => {
      starting.resolve()
      await settle()
    })
    expect(ops()).toHaveLength(0)
  })
})

describe('"Terminar" e "Descartar" durante a gravação', () => {
  it('"Terminar": "Finalizando a gravação…" enquanto o arquivo fecha, até a gravação pronta aparecer', async () => {
    const finishing = deferred()
    const finish = vi.fn(() => finishing.promise)
    useRecorderStore.setState({ active: true, seconds: 5, mode: 'tab', live: LIVE, finish })
    render(
      <>
        <RecordingWindow />
        <BlockingWindow />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Terminar' }))
    await flush()
    expect(finish).toHaveBeenCalledTimes(1)
    expect(ops()).toMatchObject([{ title: 'Finalizando a gravação…' }])
    await act(async () => {
      finishing.resolve()
      await settle()
    })
    expect(ops()).toHaveLength(0)
  })

  it('"Descartar": "Descartando a gravação…" até o arquivo sair', async () => {
    const discarding = deferred()
    const cancel = vi.fn(() => discarding.promise)
    useRecorderStore.setState({ active: true, seconds: 5, mode: 'microphone', live: LIVE, cancel })
    render(
      <>
        <RecordingWindow />
        <BlockingWindow />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }))
    await flush()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(ops()).toMatchObject([{ title: 'Descartando a gravação…' }])
    await act(async () => {
      discarding.resolve()
      await settle()
    })
    expect(ops()).toHaveLength(0)
  })

  it('o gravador só diz que terminou depois de fechar o arquivo (e de deixá-lo pulável)', async () => {
    const handlers: RecorderCallbacks = { onLive: vi.fn(), onTick: vi.fn(), onFinished: vi.fn(), onCancelled: vi.fn(), onError: vi.fn() }
    const recorder = new MeetingRecorder(handlers)
    await recorder.start('tab')
    FakeMediaRecorder.instances.at(-1)!.emit('x')
    await recorder.finish()
    expect(handlers.onFinished).toHaveBeenCalledTimes(1)

    const other = new MeetingRecorder(handlers)
    await other.start('tab')
    await other.cancel()
    expect(handlers.onCancelled).toHaveBeenCalledTimes(1)
  })

  it('a loja também: "finish" resolve com a gravação pronta', async () => {
    await useRecorderStore.getState().start('tab')
    FakeMediaRecorder.instances.at(-1)!.emit('x')
    await useRecorderStore.getState().finish()
    expect(useRecorderStore.getState().result).not.toBeNull()
  })
})

describe('Guardar a mídia da gravação no Drive', () => {
  const recording = () => new NodeFile([new Uint8Array(8)], 'Reunião 14-10-2026, 09-00-00.webm', { type: 'audio/webm' }) as unknown as File
  const request = (file: File) => ({ file, storedName: null, durationSeconds: 65, folderId: null, storage: 'drive' as const, litterboxTime: '72h' as const, marks: [], transcribe: false })

  it('a nota abre, e "Guardando a mídia no Drive…" segura o app até o envio acabar (barra sem número: o envio não conta bytes)', async () => {
    const slow = slowLibrary()
    const upload = deferred<{ ref: string }>()
    const putSource = vi.fn(() => upload.promise)
    Object.assign(slow.repo, { putSource })
    const file = recording()

    const id = await useJobsStore.getState().saveRecording(request(file))
    await flush()
    expect(putSource).toHaveBeenCalledWith(id, file, file.name)
    expect(ops()).toHaveLength(1)
    expect(ops()[0]).toMatchObject({ title: 'Guardando a mídia no Drive…' })
    expect(ops()[0].total).toBeUndefined()
    expect(ops()[0].totalBytes).toBeUndefined()

    await act(async () => {
      upload.resolve({ ref: 'drive-1' })
      await settle()
    })
    expect(ops()).toHaveLength(0)
    expect(fileNow(id)?.origin).toMatchObject({ storage: 'drive', storedFileId: 'drive-1' })
  })

  it('o envio falha: a janela fecha e a linha em Tarefas diz o motivo, como antes', async () => {
    const slow = slowLibrary()
    const upload = deferred<{ ref: string }>()
    Object.assign(slow.repo, { putSource: vi.fn(() => upload.promise) })

    await useJobsStore.getState().saveRecording(request(recording()))
    await flush()
    expect(ops()).toHaveLength(1)
    await act(async () => {
      upload.reject(new Error('Sem espaço no Drive'))
      await settle()
    })
    expect(ops()).toHaveLength(0)
    expect(jobsNow()[0]).toMatchObject({ status: 'error', title: 'Guardar a mídia: Reunião 14-10-2026, 09-00-00', error: 'Sem espaço no Drive' })
  })
})
