import { createContext, useContext, useReducer, type ReactNode } from 'react'
import type { AppState, AppAction, QuestionsResponse } from '@/types'
import { shuffleArray } from '@/lib/utils'

const initialState: AppState = {
  generatedMarkdown: '',
  questionsData: null,
  userAnswers: {},
  currentQuestionIndex: 0,
  isLoading: false,
  loadingMessage: '',
  loadingSubMessage: '',
  errorMessage: null,
  savedFileId: null,
  savedFileName: null,
  savedFileType: null,
  savedFileHash: null,
  savedFolderId: null,
  savedFolderName: null,
  lastOpenedFolderId: null,
}

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_MARKDOWN':
      return { ...state, generatedMarkdown: action.payload, questionsData: null, userAnswers: {}, currentQuestionIndex: 0, errorMessage: null }
    case 'SET_QUESTIONS': {
      const shuffled = action.payload.questions
        ? { ...action.payload, questions: shuffleArray(action.payload.questions) }
        : action.payload
      return { ...state, questionsData: shuffled, userAnswers: {}, currentQuestionIndex: 0 }
    }
    case 'SET_MARKDOWN_AND_QUESTIONS': {
      const questions = action.payload.questions
        ? { ...action.payload.questions, questions: shuffleArray(action.payload.questions.questions) }
        : null
      return {
        ...state,
        generatedMarkdown: action.payload.markdown,
        questionsData: questions,
        userAnswers: {},
        currentQuestionIndex: 0,
        errorMessage: null,
      }
    }
    case 'SET_USER_ANSWER':
      return {
        ...state,
        userAnswers: { ...state.userAnswers, [action.payload.questionId]: action.payload.answer },
      }
    case 'SET_CURRENT_QUESTION_INDEX':
      return { ...state, currentQuestionIndex: action.payload }
    case 'SET_LOADING':
      return {
        ...state,
        isLoading: action.payload.isLoading,
        loadingMessage: action.payload.message ?? state.loadingMessage,
        loadingSubMessage: action.payload.subMessage ?? state.loadingSubMessage,
      }
    case 'SET_ERROR':
      return { ...state, errorMessage: action.payload }
    case 'SET_SAVED_FILE':
      return {
        ...state,
        savedFileId: action.payload.fileId,
        savedFileName: action.payload.fileName,
        savedFileType: action.payload.fileType ?? null,
        // Not every caller knows the hash (e.g. renaming in place) — keep the current one then.
        savedFileHash: action.payload.fileHash ?? state.savedFileHash,
        savedFolderId: action.payload.folderId,
        savedFolderName: action.payload.folderName,
      }
    case 'SET_LAST_OPENED_FOLDER':
      return { ...state, lastOpenedFolderId: action.payload }
    case 'RESET':
      return { ...initialState }
    default:
      return state
  }
}

// ── Tabs ──
//
// Each tab owns its own AppState, so opening or generating a second document
// no longer discards the first. `useAppState`/`useAppDispatch` keep their exact
// old shape (a single AppState + a dispatch that takes a plain AppAction) — every
// existing consumer works unchanged, because both now implicitly target whichever
// tab is active *at the moment the action is handled*, not at the moment the
// component rendered. A caller that needs to target a specific (possibly inactive)
// tab — e.g. a background generation finishing while another tab is on screen —
// adds `tabId` to the action instead.

export type TabScopedAction = AppAction & { tabId?: string }

interface CreateTabAction {
  type: 'CREATE_TAB'
  payload?: { makeActive?: boolean }
}
interface CloseTabAction {
  type: 'CLOSE_TAB'
  payload: { id: string }
}
interface SwitchTabAction {
  type: 'SWITCH_TAB'
  payload: { id: string }
}

export type TabsAction = TabScopedAction | CreateTabAction | CloseTabAction | SwitchTabAction

export interface TabsState {
  byId: Record<string, AppState>
  order: string[]
  activeId: string
}

function newTabId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const firstTabId = newTabId()
const initialTabsState: TabsState = {
  byId: { [firstTabId]: { ...initialState } },
  order: [firstTabId],
  activeId: firstTabId,
}

function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'CREATE_TAB': {
      const id = newTabId()
      const makeActive = action.payload?.makeActive ?? true
      return {
        byId: { ...state.byId, [id]: { ...initialState } },
        order: [...state.order, id],
        activeId: makeActive ? id : state.activeId,
      }
    }
    case 'CLOSE_TAB': {
      const { id } = action.payload
      if (!(id in state.byId)) return state
      // Never end up with zero tabs — closing the last one just clears it in place.
      if (state.order.length === 1) {
        return { byId: { [id]: { ...initialState } }, order: [id], activeId: id }
      }
      const index = state.order.indexOf(id)
      const order = state.order.filter(t => t !== id)
      const byId = { ...state.byId }
      delete byId[id]
      const activeId = state.activeId === id
        ? order[Math.max(0, index - 1)]
        : state.activeId
      return { byId, order, activeId }
    }
    case 'SWITCH_TAB':
      return state.byId[action.payload.id] ? { ...state, activeId: action.payload.id } : state
    default: {
      const targetId = action.tabId ?? state.activeId
      const current = state.byId[targetId]
      if (!current) return state
      return { ...state, byId: { ...state.byId, [targetId]: appReducer(current, action) } }
    }
  }
}

interface AppContextType {
  tabs: TabsState
  dispatch: React.Dispatch<TabsAction>
}

const AppContext = createContext<AppContextType | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [tabs, dispatch] = useReducer(tabsReducer, initialTabsState)
  return <AppContext.Provider value={{ tabs, dispatch }}>{children}</AppContext.Provider>
}

/** The active tab's document state — same shape every consumer already used. */
export function useAppState(): AppState {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useAppState must be used within AppProvider')
  return ctx.tabs.byId[ctx.tabs.activeId]
}

/** Dispatches against the active tab unless the action carries its own `tabId`. */
export function useAppDispatch(): React.Dispatch<TabsAction> {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useAppDispatch must be used within AppProvider')
  return ctx.dispatch
}

/** Tab list + lifecycle, for the tab bar. */
export function useTabs() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useTabs must be used within AppProvider')
  return {
    order: ctx.tabs.order,
    activeId: ctx.tabs.activeId,
    byId: ctx.tabs.byId,
    createTab: (opts?: { makeActive?: boolean }) => ctx.dispatch({ type: 'CREATE_TAB', payload: opts }),
    closeTab: (id: string) => ctx.dispatch({ type: 'CLOSE_TAB', payload: { id } }),
    switchTab: (id: string) => ctx.dispatch({ type: 'SWITCH_TAB', payload: { id } }),
  }
}
