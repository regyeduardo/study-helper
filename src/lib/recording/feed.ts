export const FEED_RING_SOURCE = `
class FeedRing {
  constructor(size, reserve) {
    this.size = size
    this.reserve = reserve
    this.ring = new Float32Array(size)
    this.write = 0
    this.read = 0
    this.primed = false
    this.owed = 0
  }
  push(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.write % this.size] = samples[i]
      this.write++
    }
    if (this.write - this.read > this.size) this.read = this.write - this.size
  }
  pull(out) {
    if (this.owed > this.size) {
      this.owed = 0
      this.primed = false
    }
    if (!this.primed) {
      if (this.write - this.read < this.reserve) {
        out.fill(0)
        return
      }
      this.primed = true
    }
    if (this.owed > 0) {
      const dropped = Math.min(this.owed, this.write - this.read)
      this.read += dropped
      this.owed -= dropped
    }
    const ready = Math.min(out.length, this.write - this.read)
    for (let i = 0; i < ready; i++) {
      out[i] = this.ring[this.read % this.size]
      this.read++
    }
    for (let i = ready; i < out.length; i++) out[i] = 0
    this.owed += out.length - ready
  }
}
`

export interface FeedRing {
  push(samples: Float32Array): void
  pull(out: Float32Array): void
}

export function createFeedRing(size: number, reserve: number): FeedRing {
  const Ring = new Function(`${FEED_RING_SOURCE}; return FeedRing`)() as new (size: number, reserve: number) => FeedRing
  return new Ring(size, reserve)
}
