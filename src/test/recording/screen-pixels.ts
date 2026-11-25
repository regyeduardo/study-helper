import { LOOK_HEIGHT, LOOK_WIDTH } from '@/lib/recording/frame-grab'

/** A screen as the small copy the optimized recording looks at (LOOK_WIDTH × LOOK_HEIGHT, RGBA): white, with gray rectangles on it. */
export class FakeScreen {
  readonly pixels = new Uint8ClampedArray(LOOK_WIDTH * LOOK_HEIGHT * 4).fill(255)
  private seed = 7

  /** Paints a rectangle (in pixels of the small copy) with one gray, or with a gray per pixel. */
  paint(x: number, y: number, width: number, height: number, gray: number | (() => number)): void {
    for (let row = y; row < y + height; row++) {
      for (let column = x; column < x + width; column++) {
        const at = (row * LOOK_WIDTH + column) * 4
        const value = typeof gray === 'number' ? gray : gray()
        this.pixels[at] = this.pixels[at + 1] = this.pixels[at + 2] = value
      }
    }
  }

  /** A camera: the rectangle gets a new picture (a different gray in each pixel), as a person moving does. */
  camera(x: number, y: number, width: number, height: number): void {
    this.paint(x, y, width, height, () => this.random())
  }

  copy(): Uint8ClampedArray {
    return this.pixels.slice()
  }

  // the same pictures in every run
  private random(): number {
    this.seed = (this.seed * 1103515245 + 12345) % 2147483648
    return this.seed % 256
  }
}
