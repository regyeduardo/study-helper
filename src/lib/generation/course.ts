import type { CourseAnalysis, CoursePlanLesson, CoursePlanModule } from '@/types/domain'
import { extractJson } from '@/lib/generation/mermaid'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'

function find(material: string, marker: unknown, since: number): number | null {
  if (typeof marker !== 'string' || !marker.trim()) return null
  const text = marker.trim()
  let position = material.indexOf(text, since)
  if (position >= 0) return since === 0 ? position : position + text.length
  let words = text.split(/\s+/)
  while (words.length > 3) {
    words = words.slice(0, -1)
    const shorter = words.join(' ')
    position = material.indexOf(shorter, since)
    if (position >= 0) return since === 0 ? position : position + shorter.length
  }
  return null
}

export function sliceMaterial(material: string, start: unknown, end: unknown): string {
  if (!material) return ''
  const begin = find(material, start, 0)
  if (begin === null) return ''
  const stop = find(material, end, begin)
  return stop === null ? material.slice(begin) : material.slice(begin, stop)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim()
}

export function readAnalysis(payload: Record<string, unknown>, material: string): CourseAnalysis {
  const modules: CoursePlanModule[] = []
  for (const item of Array.isArray(payload.modules) ? (payload.modules as Record<string, unknown>[]) : []) {
    const title = text(item.title)
    if (!title) continue
    const lessons: CoursePlanLesson[] = (Array.isArray(item.lessons) ? (item.lessons as Record<string, unknown>[]) : [])
      .filter(lesson => text(lesson.title))
      .map(lesson => ({ title: text(lesson.title), covers: text(lesson.covers), excerpt: sliceMaterial(material, lesson.start, lesson.end) }))
    modules.push({ title, covers: text(item.covers), excerpt: sliceMaterial(material, item.start, item.end), lessons })
  }
  const isCourse = Boolean(payload.is_course) && modules.length > 0
  const lessonCount = modules.reduce((sum, module) => sum + Math.max(1, module.lessons.length), 0)
  return { isCourse, name: text(payload.name), description: text(payload.description), modules: isCourse ? modules : [], lessonCount: isCourse ? lessonCount : 0 }
}

export async function analyzeCourse(content: string, session: GenerationSession): Promise<CourseAnalysis> {
  const payload = extractJson(await session.chat(content, PROMPTS.COURSE_ANALYSIS_PROMPT))
  if (payload === null) return { isCourse: false, name: '', description: '', modules: [], lessonCount: 0 }
  return readAnalysis(payload, content)
}
