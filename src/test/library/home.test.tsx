import { beforeEach, describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'

import { today } from '@/lib/generation/cards'
import { useLibraryStore } from '@/stores/library'
import { renderAt, seedLibrary } from '@/test/library/explorer-fixture'

beforeEach(() => {
  seedLibrary()
  const day = today()
  useLibraryStore.setState(state => ({
    files: state.files.map(file =>
      file.id === 'limites'
        ? { ...file, cardDue: [day, day, '2999-01-01'], mastery: 50 }
        : file.id === 'derivadas'
          ? { ...file, cardDue: [day] }
          : file.id === 'ondas'
            ? { ...file, origin: { input: 'recording', name: 'corredor.webm', mime: 'audio/webm', durationSeconds: 360, storage: 'none' }, words: 0, name: 'Conversa no corredor' }
            : file,
    ),
  }))
})

const block = (name: string) => screen.getByRole('region', { name })
const names = (region: HTMLElement) => within(region).getAllByRole('button').map(button => button.textContent ?? '')

describe('Início shows what to do today', () => {
  it('cards due today, notes to review, recordings without transcription and the latest notes', () => {
    renderAt('/')
    expect(within(block('Cartões para hoje')).getByText('3 cartões em 2 notas')).toBeInTheDocument()
    expect(names(block('Cartões para hoje'))).toEqual(['Limites laterais e continuidade2', 'Derivadas pela definição1'])
    expect(names(block('Para revisar'))[0]).toContain('Limites laterais e continuidade')
    expect(names(block('Gravações sem transcrição'))).toEqual(['Conversa no corredorÁudio · 6 min'])
    expect(names(block('Últimas notas')).length).toBeGreaterThan(0)
  })
})
