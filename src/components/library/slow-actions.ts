import { exportFileAsMarkdown, exportFileAsPdf, exportFilesAsZip, exportFileAsZip } from '@/lib/exports/library-export'
import { working } from '@/lib/working'

const EXPORT_TITLE = { md: 'Preparando o arquivo .md…', zip: 'Preparando o arquivo .zip…', pdf: 'Preparando o PDF…' } as const
const EXPORTS = { md: exportFileAsMarkdown, zip: exportFileAsZip, pdf: exportFileAsPdf }

/** Exportar reads the note (a Drive read) and builds the file (a PDF takes seconds): a line says so from the click until the download starts. */
export const exportWithFeedback = (kind: keyof typeof EXPORTS, id: string) => working(EXPORT_TITLE[kind], () => EXPORTS[kind](id), { message: 'Montando o arquivo' })

/** The same for the notes of a selection, in one .zip. */
export const exportManyWithFeedback = (ids: string[]) => working(EXPORT_TITLE.zip, () => exportFilesAsZip(ids), { message: `Montando o arquivo com ${ids.length} ${ids.length === 1 ? 'nota' : 'notas'}` })
