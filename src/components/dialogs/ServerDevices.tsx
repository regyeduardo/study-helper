import { useCallback, useEffect, useState } from 'react'

import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { apiMessage, listDevices, type ServerDevice, signOutDevice } from '@/controllers/api.controller'
import { useNestedEscape } from '@/hooks/use-nested-escape'
import { agoText } from '@/utils/format'

import '@/styles/account.css'

const ASK_AGAIN = 'Os aparelhos encerrados vão pedir para entrar de novo.'

/** Configurações › Dispositivos with a session on the server (spec 003, entrega 3, opção B): each device, "Sair" per row and for all the others. */
export function ServerDevices() {
  const [devices, setDevices] = useState<ServerDevice[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [leaving, setLeaving] = useState<string[]>([])
  const [asking, setAsking] = useState(false)

  const load = useCallback(async () => {
    try {
      setDevices(await listDevices())
      setProblem(null)
    } catch (failure) {
      setProblem(apiMessage(failure))
    }
  }, [])
  useEffect(() => void load(), [load])

  const signOut = async (ids: string[]) => {
    setLeaving(ids)
    setProblem(null)
    const results = await Promise.allSettled(ids.map(id => signOutDevice(id)))
    const gone = ids.filter((_, index) => results[index].status === 'fulfilled')
    setDevices(current => (current ?? []).filter(device => !gone.includes(device.id)))
    const failed = results.find(result => result.status === 'rejected')
    if (failed) setProblem(apiMessage(failed.reason))
    setLeaving([])
  }

  const others = (devices ?? []).filter(device => !device.current)
  const sorted = [...(devices ?? [])].sort((a, b) => Number(b.current) - Number(a.current) || b.seenAt.localeCompare(a.seenAt))
  return (
    <div className="field acc-devices">
      <div className="acc-dev-head">
        <span className="acc-head-title">Aparelhos conectados</span>
        <button type="button" className="btn" disabled={!others.length || leaving.length > 0} onClick={() => setAsking(true)}>
          Sair de todos os outros
        </button>
      </div>
      {devices === null && !problem && <span className="faint">Carregando os aparelhos…</span>}
      {devices !== null && (
        <table className="acc-table">
          <thead>
            <tr>
              <th scope="col">Aparelho</th>
              <th scope="col">Visto</th>
              <th scope="col">
                <span className="sr-only">Sair</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(device => (
              <tr key={device.id}>
                <td>
                  <span className="acc-dev-name">
                    <Icon name="monitor" />
                    <span>
                      {device.name}
                      {device.current && <span className="acc-this"> · este aparelho</span>}
                    </span>
                  </span>
                </td>
                <td className="acc-seen">{device.current ? 'agora' : agoText(device.seenAt)}</td>
                <td className="acc-act">
                  {!device.current && (
                    <button type="button" className="btn quiet" aria-label={`Sair de ${device.name}`} disabled={leaving.includes(device.id)} onClick={() => void signOut([device.id])}>
                      {leaving.includes(device.id) ? 'Saindo…' : 'Sair'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <span className="faint acc-hint">{ASK_AGAIN}</span>
      {problem && (
        <span className="acc-error" role="alert">
          {problem}
        </span>
      )}
      {asking && (
        <SignOutOthers
          onClose={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false)
            void signOut(others.map(device => device.id))
          }}
        />
      )}
    </div>
  )
}

function SignOutOthers({ onClose, onConfirm }: { onClose(): void; onConfirm(): void }) {
  useNestedEscape(onClose)
  return (
    <Dialog
      title="Sair de todos os outros aparelhos?"
      size="narrow"
      role="alertdialog"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn quiet" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn danger" onClick={onConfirm}>
            Sair de todos
          </button>
        </>
      }
    >
      <div className="db">
        <span className="muted">{ASK_AGAIN} Este aparelho continua conectado.</span>
      </div>
    </Dialog>
  )
}
