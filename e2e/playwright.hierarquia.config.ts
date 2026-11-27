import base from './playwright.dois-aparelhos.config'

/** Spec 005, história 1: the same account's hierarchy on two real browsers, without the app structure (backend and app of its own). */
export default { ...base, testMatch: 'hierarquia-dois-aparelhos.spec.ts', outputDir: `${base.outputDir}-hierarquia` }
