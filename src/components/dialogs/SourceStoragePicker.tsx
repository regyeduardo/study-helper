import type { ReactNode } from 'react'

import type { SourceStorage } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import type { LitterboxTime } from '@/controllers/hosting.controller'
import type { StorageOption } from '@/lib/storage/source-storage'
import type { KeepLevel } from '@/stores/jobs'
import { formatBytes } from '@/utils/format'

const LEVELS: { id: KeepLevel; name: string; description: string }[] = [
  { id: 'sem-rastro', name: 'Sem rastro', description: 'Fica só a nota.' },
  { id: 'registro', name: 'Só o registro', description: 'Guarda nome, link e origem, sem o arquivo.' },
  { id: 'arquivo', name: 'Registro e arquivo', description: 'Guarda também o arquivo.' },
]

interface KeepLevelPickerProps {
  level: KeepLevel
  onLevel(level: KeepLevel): void
  /** False for an Ata: it always has an entrada (FR-055). */
  traceless: boolean
  /** Why "Registro e arquivo" cannot be picked; absent, it can. */
  fileReason?: string | null
  /** Where the file goes, shown under "Registro e arquivo". */
  children?: ReactNode
}

/** What stays of the source (FR-023): "Sem rastro", "Só o registro" or "Registro e arquivo", and then where. */
export function KeepLevelPicker({ level, onLevel, traceless, fileReason, children }: KeepLevelPickerProps) {
  return (
    <>
      <div className="field">
        <span className="lab">O que guardar da fonte</span>
        <div className="opts says-why" role="radiogroup" aria-label="O que guardar da fonte">
          {LEVELS.filter(item => traceless || item.id !== 'sem-rastro').map(item => {
            const blocked = item.id === 'arquivo' && Boolean(fileReason)
            return (
              <button key={item.id} className="opt" role="radio" aria-checked={level === item.id} aria-disabled={blocked} onClick={() => !blocked && onLevel(item.id)}>
                <span className="radio" />
                <span>
                  <b>{item.name}</b>
                  <span>
                    {item.description}
                    {blocked && <> <span className="lim">{fileReason}</span></>}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </div>
      {level === 'arquivo' && children}
    </>
  )
}

interface SourceStoragePickerProps {
  label: string
  sizeBytes: number
  options: StorageOption[]
  chosen: SourceStorage
  onChoose(storage: SourceStorage): void
  litterboxTime: LitterboxTime
  onLitterboxTime(time: LitterboxTime): void
  names?: Partial<Record<SourceStorage, { name: string; description: string }>>
}

export function SourceStoragePicker({ label, sizeBytes, options, chosen, onChoose, litterboxTime, onLitterboxTime, names = {} }: SourceStoragePickerProps) {
  return (
    <div className="field">
      <span className="lab">{label}</span>
      <div className="opts says-why" role="radiogroup" aria-label={label}>
        {options
          .filter(option => option.fits)
          .map(option => (
            <button key={option.id} className="opt" role="radio" aria-checked={chosen === option.id} aria-disabled={!option.enabled} onClick={() => option.enabled && onChoose(option.id)}>
              <span className="radio" />
              <span>
                <b>{names[option.id]?.name ?? option.name}</b>
                <span>
                  {names[option.id]?.description ?? option.description}
                  {!option.enabled && option.reason && <> <span className="lim">{option.reason}</span></>}
                </span>
              </span>
            </button>
          ))}
      </div>
      {chosen === 'litterbox' && (
        <div className="field">
          <label htmlFor="nc-until">Prazo do Litterbox</label>
          <select className="input" id="nc-until" value={litterboxTime} onChange={event => onLitterboxTime(event.target.value as LitterboxTime)}>
            {(['1h', '12h', '24h', '72h'] as LitterboxTime[]).map(time => (
              <option key={time}>{time}</option>
            ))}
          </select>
        </div>
      )}
      {options.some(option => !option.fits) && (
        <span className="faint" style={{ fontSize: 12 }}>
          Não cabem {formatBytes(sizeBytes)}: {options.filter(option => !option.fits).map(option => option.name).join(', ')}.
        </span>
      )}
      {options.find(option => option.id === chosen)?.thirdParty && (
        <div className="banner">
          <Icon name="warn" />
          <span>Serviço de terceiro, sem garantia de guardar: pode perder o arquivo. O único 100% confiável é o seu Google Drive.</span>
        </div>
      )}
    </div>
  )
}
