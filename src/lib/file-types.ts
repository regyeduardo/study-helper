import type { FileType } from '@/types/domain'

export const FILE_TYPES: { id: FileType; label: string; tone: string }[] = [
  { id: 'class', label: 'Aula', tone: 't-aula' },
  { id: 'explanation', label: 'Explicação', tone: 't-exp' },
  { id: 'meeting', label: 'Reunião', tone: 't-reu' },
  { id: 'reading', label: 'Leitura', tone: 't-lei' },
]

export function typeInfo(type: FileType) {
  return FILE_TYPES.find(item => item.id === type) ?? FILE_TYPES[0]
}

export const REVIEW_BELOW = 70
export const LOW_MASTERY_BELOW = 60
