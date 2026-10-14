import { describe, expect, it } from 'vitest'
import { createFeedRing } from '@/lib/recording/feed'

const QUANTUM = 128
const RESERVE = 1280
const SIZE = 48000

function ramp(from: number, length: number): Float32Array {
  return Float32Array.from({ length }, (_, index) => from + index + 1)
}

function play(arrivals: Map<number, number>, quanta: number): Float32Array {
  const ring = createFeedRing(SIZE, RESERVE)
  const heard = new Float32Array(quanta * QUANTUM)
  let sent = 0
  for (let turn = 0; turn < quanta; turn++) {
    const arriving = arrivals.get(turn) ?? 0
    if (arriving) {
      ring.push(ramp(sent, arriving))
      sent += arriving
    }
    const out = new Float32Array(QUANTUM)
    ring.pull(out)
    heard.set(out, turn * QUANTUM)
  }
  return heard
}

function holesAfterStart(heard: Float32Array): number {
  const first = heard.findIndex(value => value !== 0)
  let holes = 0
  for (let index = first; index < heard.length; index++) if (heard[index] === 0 && heard[index - 1] !== 0) holes++
  return holes
}

describe('integration sound reserve', () => {
  it('plays without a single hole when the sound arrives in uneven bursts', () => {
    const arrivals = new Map<number, number>()
    for (let turn = 0; turn < 400; turn += 5) arrivals.set(turn + (turn % 3), QUANTUM * 5)
    const heard = play(arrivals, 400)
    expect(holesAfterStart(heard)).toBe(0)
    const first = heard.findIndex(value => value !== 0)
    expect(heard[first]).toBe(1)
    expect(heard[first + 5000]).toBe(5001)
  })

  it('waits for the reserve before it starts to play', () => {
    const heard = play(new Map([[0, QUANTUM * 4]]), 20)
    expect(heard.every(value => value === 0)).toBe(true)
  })

  it('throws away what arrived too late instead of pushing the sound further back', () => {
    const arrivals = new Map<number, number>()
    for (let turn = 0; turn < 100; turn++) arrivals.set(turn, QUANTUM)
    arrivals.set(140, QUANTUM * 41)
    for (let turn = 141; turn < 260; turn++) arrivals.set(turn, QUANTUM)
    const heard = play(arrivals, 260)
    const start = heard.findIndex(value => value !== 0)
    const delayAtStart = start + 1 - heard[start]
    const late = 250 * QUANTUM
    expect(heard[late]).not.toBe(0)
    expect(late + 1 - heard[late]).toBe(delayAtStart)
    expect(holesAfterStart(heard)).toBe(1)
  })

  it('starts over after a long pause, without swallowing the sound that comes next', () => {
    const arrivals = new Map<number, number>()
    for (let turn = 0; turn < 50; turn++) arrivals.set(turn, QUANTUM)
    for (let turn = 600; turn < 700; turn++) arrivals.set(turn, QUANTUM)
    const heard = play(arrivals, 700)
    const resumed = heard.findIndex((value, index) => index > 600 * QUANTUM && value !== 0)
    expect(heard[resumed]).toBe(50 * QUANTUM + 1)
    expect(resumed).toBeLessThan(612 * QUANTUM)
  })

  it('never keeps more than its size', () => {
    const ring = createFeedRing(1000, 100)
    ring.push(ramp(0, 5000))
    const out = new Float32Array(QUANTUM)
    ring.pull(out)
    expect(out[0]).toBe(4001)
  })
})
