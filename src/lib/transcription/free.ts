import { getFreeBalanceController, TranscriptionError } from '@/controllers/transcription.controller'
import { decodeToMono16k, durationOf, withoutSilence } from '@/lib/transcription/audio'
import { useAccountStore } from '@/stores/account'

export const FREE_MINUTES_INVITE = 'Entre com o Google e ganhe 30 minutos grátis por dia'

export function minutesText(seconds: number, round: (value: number) => number = Math.floor): string {
  const minutes = Math.max(0, round(seconds / 60))
  return `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`
}

export function shortOfMinutesText(remainingSeconds: number, speechSeconds: number): string {
  const remaining = minutesText(remainingSeconds)
  return `${remaining.startsWith('1 ') ? 'Falta' : 'Faltam'} ${remaining} hoje e o áudio tem ${minutesText(speechSeconds, Math.ceil)} de fala.`
}

export class NotEnoughFreeMinutesError extends TranscriptionError {
  constructor(
    readonly remainingSeconds: number,
    readonly speechSeconds: number,
  ) {
    super(shortOfMinutesText(remainingSeconds, speechSeconds))
  }
}

export async function freeMinutesToken(): Promise<string> {
  const accounts = useAccountStore.getState()
  const account = accounts.active()
  if (account.kind !== 'google') throw new TranscriptionError(`${FREE_MINUTES_INVITE}.`)
  return accounts.tokenFor(account.id)
}

export async function freeBalanceSeconds(): Promise<number> {
  return getFreeBalanceController(await freeMinutesToken())
}

export async function speechSecondsOf(audio: Blob): Promise<number> {
  return durationOf(withoutSilence(await decodeToMono16k(audio)))
}
