import { create } from 'zustand'

export interface Heading {
  id: string
  level: number
  text: string
}

interface DocumentState {
  fileId: string | null
  headings: Heading[]
  scroller: HTMLElement | null
  setHeadings(fileId: string, headings: Heading[]): void
  setScroller(element: HTMLElement | null): void
}

export const useDocumentStore = create<DocumentState>(set => ({
  fileId: null,
  headings: [],
  scroller: null,
  setHeadings: (fileId, headings) => set({ fileId, headings }),
  setScroller: element => set({ scroller: element }),
}))
