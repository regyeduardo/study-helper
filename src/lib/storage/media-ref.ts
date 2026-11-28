/**
 * T197 (dono, 27/11: "Por que está passando ffmpeg no navegador ao invés do servidor?"): the media of the App a downloaded blob is, so the
 * heavy reading of it (the thumbnails of the whole video) can be asked of the server, where ffmpeg reads it where it is kept.
 */
const kept = new WeakMap<Blob, { item: string; media: string }>()

/** Remembers that `blob` is the media `ref` of the App ("app:<item>/<media>"); any other ref is not of the App and is ignored. */
export function rememberAppMedia(blob: Blob, ref: string | null | undefined): void {
  const found = ref ? /^app:([^/]+)\/(.+)$/.exec(ref) : null
  if (found) kept.set(blob, { item: found[1], media: found[2] })
}

/** The App media this blob is, or null. */
export const appMediaOf = (blob: Blob): { item: string; media: string } | null => kept.get(blob) ?? null
