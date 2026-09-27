const dom = (globalThis as { jsdom?: { window: Window } }).jsdom

if (dom && typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: dom.window.sessionStorage })
}
