import { describe, expect, it } from 'vitest'

import { ChangeGate, type ScreenChange } from '@/lib/recording/frame-grab'
import { FakeScreen } from '@/test/recording/screen-pixels'

// T173 (dono, 25/11): "uma pessoa mexendo, sem nada de relevante para o conteúdo, atualiza o quadro mesmo assim" e "tem que ter muito
// cuidado para caso o conteúdo relevante é que esteja atualizando com mais frequência". A gravação otimizada olha uma cópia pequena da
// tela a cada 100 ms: o que mudou como conteúdo pede quadro na hora ('content'); o que só uma câmera mudou espera o quadro de cada
// segundo ('camera').
const LOOK = 100

interface Run {
  gate: ChangeGate
  screen: FakeScreen
  now: number
}

/** One look; the frame goes out when the look calls for it, and once a second anyway, as the canvas does. */
function look(run: Run): ScreenChange {
  run.now += LOOK
  const seen = run.gate.look(run.screen.copy(), run.now)
  if (seen === 'content' || run.now % 1000 === 0) run.gate.sent()
  return seen
}

/** Looks for `ms`, changing the screen before each look. */
function during(run: Run, ms: number, change: (index: number) => void = () => undefined): ScreenChange[] {
  const seen: ScreenChange[] = []
  for (let index = 0; index < ms / LOOK; index++) {
    change(index)
    seen.push(look(run))
  }
  return seen
}

function start(): Run {
  const run = { gate: new ChangeGate(), screen: new FakeScreen(), now: 0 }
  look(run)
  return run
}

// a camera in a corner: 48 × 32 of the 256 × 144 of the copy, about 4% of the screen
const camera = (run: Run) => run.screen.camera(200, 104, 48, 32)
const slide = (run: Run, gray: number) => run.screen.paint(16, 16, 160, 80, gray)

describe('o que muda na tela da gravação otimizada', () => {
  it('tela parada: nada pede quadro', () => {
    const run = start()
    expect(during(run, 3000)).toEqual(Array(30).fill('none'))
  })

  it('só uma câmera pequena mexendo sem parar: nos primeiros segundos é conteúdo; depois de uns 5 s, o que ela muda espera o quadro de cada segundo', () => {
    const run = start()
    const seen = during(run, 8000, () => camera(run))
    expect(seen.slice(0, 40)).toEqual(Array(40).fill('content'))
    expect(seen.slice(-20)).toEqual(Array(20).fill('camera'))
    expect(seen.indexOf('camera')).toBeGreaterThanOrEqual(45)
  })

  it('a borda da câmera, que mexe menos (o fundo atrás da pessoa, a célula metade fora da imagem), faz parte dela', () => {
    const run = start()
    // the camera's picture moves all the time; right below it, a strip that changes a little in 4 of every 5 looks (busy, but less
    // than the camera), as the cells half over the picture measured in Chromium (0,55 to 0,82)
    const edge = [230, 236, 230, 236, 236]
    const seen = during(run, 10_000, index => {
      camera(run)
      run.screen.paint(200, 136, 48, 4, edge[index % edge.length])
    })
    expect(seen.slice(-20)).toEqual(Array(20).fill('camera'))
  })

  it('o slide que muda colado na câmera é conteúdo na hora', () => {
    const run = start()
    during(run, 8000, () => camera(run))
    const seen = during(run, 500, index => {
      camera(run)
      if (index === 2) run.screen.paint(120, 96, 80, 40, 30)
    })
    expect(seen).toEqual(['camera', 'camera', 'content', 'camera', 'camera'])
  })

  it('o slide que muda enquanto a câmera mexe é conteúdo na hora', () => {
    const run = start()
    during(run, 8000, () => camera(run))
    const seen = during(run, 1000, index => {
      camera(run)
      if (index === 3) slide(run, 40)
    })
    expect(seen).toEqual(['camera', 'camera', 'camera', 'content', 'camera', 'camera', 'camera', 'camera', 'camera', 'camera'])
  })

  it('quem digita sem parar fora da câmera continua sendo conteúdo, com a câmera mexendo ou sem ela', () => {
    for (const withCamera of [false, true]) {
      const run = start()
      if (withCamera) during(run, 8000, () => camera(run))
      // 5 letters a second for 20 s: each letter 2 × 3 pixels of the copy, right after the last one, 60 letters a line
      const seen = during(run, 20_000, index => {
        if (withCamera) camera(run)
        if (index % 2) return
        const letter = index / 2
        run.screen.paint(16 + (letter % 60) * 2, 40 + Math.floor(letter / 60) * 6, 2, 3, 0)
      })
      expect(seen.filter((_, index) => index % 2 === 0)).toEqual(Array(100).fill('content'))
      expect(seen.filter((_, index) => index % 2 === 1)).toEqual(Array(100).fill(withCamera ? 'camera' : 'none'))
    }
  })

  it('o que se mexe sem parar em um terço da tela ou mais (um vídeo mostrado, uma demonstração, as câmeras na tela toda) é conteúdo o tempo todo', () => {
    const run = start()
    // 160 × 96 of the 256 × 144: 42% of the screen
    const seen = during(run, 15_000, () => run.screen.camera(0, 0, 160, 96))
    expect(seen).toEqual(Array(150).fill('content'))
  })

  it('a câmera que para uns segundos e volta a mexer continua câmera', () => {
    const run = start()
    during(run, 8000, () => camera(run))
    expect(during(run, 6000)).not.toContain('content')
    expect(during(run, 2000, () => camera(run))).toEqual(Array(20).fill('camera'))
  })

  it('parada por mais tempo, deixa de ser câmera: o que mudar ali volta a ser conteúdo', () => {
    const run = start()
    during(run, 8000, () => camera(run))
    during(run, 15_000)
    camera(run)
    expect(look(run)).toBe('content')
  })
})
