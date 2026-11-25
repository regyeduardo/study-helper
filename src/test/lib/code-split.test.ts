import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

// Spec 007 (T039, research R6): Idiomas e a Administração não vêm com o app; carregam quando são usadas (e são buscadas quando o app
// fica ocioso). Um import estático delas em qualquer arquivo do caminho de abertura as traria de volta para o arquivo inicial.

const root = path.resolve(__dirname, '../../..')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8')
const staticImports = (source: string) => [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map(match => match[1])

describe('o que abre com o app', () => {
  it('as rotas carregam Idiomas e a Administração sob demanda', () => {
    const routes = read('src/routes.tsx')
    const eager = staticImports(routes)
    expect(eager.filter(source => source.startsWith('@/pages/idiomas') || source.startsWith('@/pages/admin'))).toEqual([])
    for (const page of ['@/pages/idiomas', '@/pages/idiomas/language', '@/pages/idiomas/study', '@/pages/admin']) expect(routes).toContain(`import('${page}')`)
  })

  it('nada do caminho de abertura importa essas páginas direto', () => {
    for (const file of ['src/main.tsx', 'src/App.tsx', 'src/pages/workspace/index.tsx', 'src/lib/paths.ts', 'src/lib/perf-routes.ts']) {
      const eager = staticImports(read(file))
      expect(eager.filter(source => source.startsWith('@/pages/idiomas') || source.startsWith('@/pages/admin')), file).toEqual([])
    }
  })
})
