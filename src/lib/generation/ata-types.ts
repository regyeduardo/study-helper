// Shared shapes of the "Ata" pipeline (meeting document made of checked parts).

/** Rectangle in source video pixels. */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** One still taken from the recorded video. */
export interface Shot {
  at: number
  /** JPEG data URL. */
  image: string
  width: number
  height: number
  /** 48x36 grayscale values (0-255), to skip near-identical frames. */
  signature: number[]
}

/** Where the pipeline takes stills from: the video in the browser, ffmpeg in Node scripts. */
export interface FrameSource {
  /** Source video size in pixels. */
  readonly width: number
  readonly height: number
  /** Seconds. */
  readonly duration: number
  /** Optional list of good moments to read (scene changes); without it the pipeline samples. */
  readonly scenes?: number[]
  /** Whole screen, scaled to at most 1280 px wide. */
  full(at: number): Promise<Shot>
  /** Only the box, cut from the full-resolution frame and scaled to 1280 px wide. */
  crop(at: number, box: Box): Promise<Shot>
  close?(): void
}

/** A red box drawn on a print. `box` is [x1, y1, x2, y2] in 0-1000 over the image. */
export interface Mark {
  box: number[]
  label: string
}

/** One call to the vision model: images (data URLs) + prompt, returns the raw text answer. */
export type SeeFn = (images: string[], prompt: string, maxTokens?: number) => Promise<string>
