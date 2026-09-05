import { it, expectTypeOf } from 'vitest'
import type { AgentType, FileType, InputMode, LineageStep, TempFileItem } from './index'

it('AgentType includes explicacao', () => {
  expectTypeOf<'explicacao'>().toMatchTypeOf<AgentType>()
})

it('AgentType does NOT include resumidor', () => {
  expectTypeOf<'resumidor'>().not.toMatchTypeOf<AgentType>()
})

it('FileType includes explanation and reading', () => {
  expectTypeOf<'explanation'>().toMatchTypeOf<FileType>()
  expectTypeOf<'reading'>().toMatchTypeOf<FileType>()
})

it('InputMode includes topic', () => {
  expectTypeOf<'topic'>().toMatchTypeOf<InputMode>()
})

it('LineageStep carries the origin excerpt', () => {
  expectTypeOf<LineageStep>().toHaveProperty('id')
  expectTypeOf<LineageStep>().toHaveProperty('name')
  expectTypeOf<LineageStep>().toHaveProperty('source_excerpt')
})

it('TempFileItem keeps the lineage fields', () => {
  expectTypeOf<TempFileItem>().toHaveProperty('parent_file_id')
  expectTypeOf<TempFileItem>().toHaveProperty('source_excerpt')
})

it('TranscriptionProvider includes local and openai', () => {
  expectTypeOf<'local'>().toMatchTypeOf<import('./index').TranscriptionProvider>()
  expectTypeOf<'openai'>().toMatchTypeOf<import('./index').TranscriptionProvider>()
})

