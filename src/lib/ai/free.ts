import { useAccountStore } from '@/stores/account'

export const LESSON_INPUT_TOKENS = 23887
export const LESSON_OUTPUT_TOKENS = 5351
export const FREE_AI_EXHAUSTED = 'A IA grátis de hoje acabou.'

export interface FreeAiBalance {
  inputTokens: number
  outputTokens: number
}

export function lessonsLeft(balance: FreeAiBalance): number {
  return Math.max(0, Math.min(Math.floor(balance.inputTokens / LESSON_INPUT_TOKENS), Math.floor(balance.outputTokens / LESSON_OUTPUT_TOKENS)))
}

export function lessonsText(lessons: number): string {
  return `≈ ${lessons} ${lessons === 1 ? 'aula restante' : 'aulas restantes'} hoje`
}

export function isExhausted(balance: FreeAiBalance): boolean {
  return balance.inputTokens <= 0 || balance.outputTokens <= 0
}

export async function freeAiToken(): Promise<string | null> {
  const accounts = useAccountStore.getState()
  const account = accounts.active()
  return account.kind === 'google' ? accounts.tokenFor(account.id) : null
}
