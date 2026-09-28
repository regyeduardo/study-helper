import type { SourceStorage } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import type { LitterboxTime } from '@/controllers/hosting.controller'
import type { StorageOption } from '@/lib/storage/source-storage'
import { formatBytes } from '@/utils/format'

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
      <div className="opts" role="radiogroup">
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
