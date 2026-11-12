import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { DateField } from '@/components/ui/DateField'
import { formatBrDay, maskBrDay, parseBrDay } from '@/lib/br-date'

// quinta-feira, 12 de novembro de 2026; 1º de novembro é domingo, 1º de outubro é quinta
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 12, 10, 0, 0))
})
afterEach(() => vi.useRealTimers())

function setup(value?: string, label = 'De') {
  const user = userEvent.setup()
  const onChange = vi.fn()
  const view = render(<DateField label={label} value={value} onChange={onChange} />)
  const input = () => screen.getByLabelText(label) as HTMLInputElement
  const opener = () => screen.getByRole('button', { name: `Abrir o calendário: ${label}` })
  return { user, onChange, input, opener, ...view }
}

const calendar = (label = 'De') => screen.getByRole('dialog', { name: `Calendário: ${label}` })
const title = () => within(calendar()).getByText(/^[a-zç]+ de \d{4}$/).textContent
// "5 de novembro" não pode casar com "15 de novembro": o nome do dia começa pelo número ou vem depois da vírgula
const day = (text: string) => within(calendar()).getByRole('button', { name: new RegExp(`(^|, )${text}( de \\d{4})?$`) })

describe('o que aparece no campo', () => {
  it('mostra o dia como dd/mm/aaaa, nunca como aaaa-mm-dd', () => {
    const { input } = setup('2026-11-05')
    expect(input()).toHaveValue('05/11/2026')
  })

  it('vazio, mostra a dica dd/mm/aaaa e nenhum valor', () => {
    const { input } = setup()
    expect(input()).toHaveValue('')
    expect(input()).toHaveAttribute('placeholder', 'dd/mm/aaaa')
    expect(input()).toHaveAttribute('inputmode', 'numeric')
  })

  it('não é um campo de data do navegador (que desenha no idioma do navegador)', () => {
    const { container } = setup('2026-11-05')
    expect(container.querySelector('input[type="date"]')).toBeNull()
  })

  it('o rótulo leva ao campo, e o botão do calendário tem nome próprio', () => {
    const { input, opener } = setup(undefined, 'Até')
    expect(input()).toBeInTheDocument()
    expect(opener()).toHaveAttribute('aria-haspopup', 'dialog')
    expect(opener()).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('digitar e colar', () => {
  it('só os números: as barras entram sozinhas, e o valor sai em aaaa-mm-dd só quando está completo', async () => {
    const { user, input, onChange } = setup()
    await user.type(input(), '0511')
    expect(input()).toHaveValue('05/11')
    expect(onChange).not.toHaveBeenCalled()
    await user.type(input(), '2026')
    expect(input()).toHaveValue('05/11/2026')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith('2026-11-05')
  })

  it('apagar com Backspace funciona, inclusive por cima da barra', async () => {
    const { user, input } = setup()
    await user.type(input(), '051')
    expect(input()).toHaveValue('05/1')
    await user.keyboard('{Backspace}')
    expect(input()).toHaveValue('05/')
    await user.keyboard('{Backspace}')
    expect(input()).toHaveValue('05')
    await user.keyboard('{Backspace}{Backspace}')
    expect(input()).toHaveValue('')
  })

  it('quem digita a barra por conta própria também é atendido: "5/1/2026" vira 05/01/2026', async () => {
    const { user, input, onChange } = setup()
    await user.type(input(), '5/1/2026')
    expect(input()).toHaveValue('05/01/2026')
    expect(onChange).toHaveBeenLastCalledWith('2026-01-05')
  })

  it('letras e sobras não entram', async () => {
    const { user, input } = setup()
    await user.type(input(), '05ab/11/2026999')
    expect(input()).toHaveValue('05/11/2026')
  })

  it('cola "05/11/2026"', async () => {
    const { user, input, onChange } = setup()
    await user.click(input())
    await user.paste('05/11/2026')
    expect(input()).toHaveValue('05/11/2026')
    expect(onChange).toHaveBeenLastCalledWith('2026-11-05')
  })

  it('cola "2026-11-05" e mostra 05/11/2026', async () => {
    const { user, input, onChange } = setup()
    await user.click(input())
    await user.paste('2026-11-05')
    expect(input()).toHaveValue('05/11/2026')
    expect(onChange).toHaveBeenLastCalledWith('2026-11-05')
  })

  it('cola "5/11/2026" e "05.11.2026"', async () => {
    const { user, input, onChange } = setup()
    await user.click(input())
    await user.paste('5/11/2026')
    expect(input()).toHaveValue('05/11/2026')
    expect(onChange).toHaveBeenLastCalledWith('2026-11-05')
    await user.clear(input())
    await user.paste('05.11.2026')
    expect(input()).toHaveValue('05/11/2026')
  })

  it('apagar o campo limpa aquela ponta', async () => {
    const { user, input, onChange } = setup('2026-11-05')
    await user.clear(input())
    expect(input()).toHaveValue('')
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })
})

describe('data que não vale', () => {
  it('31/02/2026: mostra uma frase curta e não muda o filtro', async () => {
    const { user, input, onChange } = setup('2026-10-01')
    await user.clear(input())
    onChange.mockClear()
    await user.type(input(), '31022026')
    expect(input()).toHaveValue('31/02/2026')
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Essa data não existe.')
    expect(input()).toHaveAttribute('aria-invalid', 'true')
    expect(input()).toHaveAccessibleDescription('Essa data não existe.')
  })

  it('corrigir o dia tira a frase e passa a valer', async () => {
    const { user, input, onChange } = setup()
    await user.type(input(), '31022026')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await user.clear(input())
    await user.type(input(), '28022026')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(input()).not.toHaveAttribute('aria-invalid', 'true')
    expect(onChange).toHaveBeenLastCalledWith('2026-02-28')
  })

  it('29/02 só vale em ano bissexto', async () => {
    const { user, input, onChange } = setup()
    await user.type(input(), '29022028')
    expect(onChange).toHaveBeenLastCalledWith('2028-02-29')
    await user.clear(input())
    await user.type(input(), '29022027')
    expect(screen.getByRole('alert')).toHaveTextContent('Essa data não existe.')
  })

  it('mês 13 e dia 00 também não valem', async () => {
    const { user, input, onChange } = setup()
    await user.type(input(), '10132026')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await user.clear(input())
    await user.type(input(), '00112026')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('ano fora de 1900 a 2100 pede outro ano', async () => {
    const { user, input, onChange } = setup()
    await user.type(input(), '05110026')
    expect(screen.getByRole('alert')).toHaveTextContent('Escolha um ano entre 1900 e 2100.')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('pela metade, só reclama quando sai do campo; enquanto digita, fica quieto', async () => {
    const { user, input, onChange } = setup()
    await user.type(input(), '05/11')
    expect(screen.queryByRole('alert')).toBeNull()
    await user.tab()
    expect(screen.getByRole('alert')).toHaveTextContent('Escreva dia, mês e ano, como 05/11/2026.')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('vazio ao sair do campo não é erro', async () => {
    const { user, input } = setup()
    await user.click(input())
    await user.tab()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('o valor que muda por fora', () => {
  function Host({ start }: { start?: string }) {
    const [value, setValue] = useState<string | undefined>(start)
    return (
      <>
        <DateField label="De" value={value} onChange={setValue} />
        <button onClick={() => setValue(undefined)}>Limpar tudo</button>
        <button onClick={() => setValue('2026-12-25')}>Natal</button>
      </>
    )
  }

  it('limpar os filtros esvazia o campo e some a frase de erro', async () => {
    const user = userEvent.setup()
    render(<Host start="2026-10-01" />)
    const input = screen.getByLabelText('De')
    await user.clear(input)
    await user.type(input, '31022026')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Natal' }))
    expect(input).toHaveValue('25/12/2026')
    expect(screen.queryByRole('alert')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Limpar tudo' }))
    expect(input).toHaveValue('')
  })

  it('o que a pessoa digita volta pelo valor sem o campo piscar nem pular', async () => {
    const user = userEvent.setup()
    render(<Host />)
    const input = screen.getByLabelText('De')
    await user.type(input, '05112026')
    expect(input).toHaveValue('05/11/2026')
  })
})

describe('o calendário', () => {
  it('abre pelo botão, com mês e dia da semana em português', async () => {
    const { user, opener } = setup('2026-11-05')
    await user.click(opener())
    expect(opener()).toHaveAttribute('aria-expanded', 'true')
    expect(title()).toBe('novembro de 2026')
    expect(within(calendar()).getAllByRole('columnheader').map(item => item.textContent)).toEqual(['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'])
    expect(within(calendar()).getByRole('columnheader', { name: 'domingo' })).toBeInTheDocument()
  })

  it('a semana começa no domingo: 1º de novembro de 2026 (domingo) fica na primeira coluna', async () => {
    const { user, opener } = setup('2026-11-05')
    await user.click(opener())
    const first = within(calendar()).getAllByRole('row')[1]
    expect(within(first).getAllByRole('gridcell')[0]).toHaveTextContent('1')
    expect(within(first).getAllByRole('gridcell')[0]).toContainElement(day('domingo, 1 de novembro de 2026'))
  })

  it('e outubro de 2026 (começa numa quinta) deixa quatro células vazias antes do dia 1', async () => {
    const { user, opener } = setup('2026-10-05')
    await user.click(opener())
    const first = within(calendar()).getAllByRole('row')[1]
    const cells = within(first).getAllByRole('gridcell')
    expect(cells.slice(0, 4).map(cell => cell.textContent)).toEqual(['', '', '', ''])
    expect(cells[4]).toHaveTextContent('1')
  })

  it('cada dia tem nome completo, o escolhido vem marcado e hoje vem sinalizado', async () => {
    const { user, opener } = setup('2026-11-05')
    await user.click(opener())
    expect(day('quinta-feira, 5 de novembro de 2026')).toHaveTextContent('5')
    expect(screen.getByRole('gridcell', { selected: true })).toContainElement(day('5 de novembro'))
    expect(day('12 de novembro')).toHaveAttribute('aria-current', 'date')
    expect(day('13 de novembro')).not.toHaveAttribute('aria-current')
  })

  it('sem valor, abre no mês de hoje', async () => {
    const { user, opener } = setup()
    await user.click(opener())
    expect(title()).toBe('novembro de 2026')
    expect(screen.queryByRole('gridcell', { selected: true })).toBeNull()
  })

  it('clicar num dia escolhe, fecha e devolve o foco ao botão', async () => {
    const { user, opener, input, onChange } = setup('2026-11-05')
    await user.click(opener())
    await user.click(day('20 de novembro'))
    expect(onChange).toHaveBeenCalledWith('2026-11-20')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener()).toHaveFocus()
    expect(input()).toBeInTheDocument()
  })

  it('o mês anterior e o próximo, inclusive virando o ano', async () => {
    const { user, opener } = setup('2026-11-05')
    await user.click(opener())
    await user.click(within(calendar()).getByRole('button', { name: 'Mês anterior' }))
    expect(title()).toBe('outubro de 2026')
    await user.click(within(calendar()).getByRole('button', { name: 'Próximo mês' }))
    await user.click(within(calendar()).getByRole('button', { name: 'Próximo mês' }))
    expect(title()).toBe('dezembro de 2026')
    await user.click(within(calendar()).getByRole('button', { name: 'Próximo mês' }))
    expect(title()).toBe('janeiro de 2027')
    expect(day('1 de janeiro de 2027')).toBeInTheDocument()
  })

  it('"Hoje" escolhe o dia de hoje', async () => {
    const { user, opener, onChange } = setup('2026-10-01')
    await user.click(opener())
    await user.click(within(calendar()).getByRole('button', { name: 'Hoje' }))
    expect(onChange).toHaveBeenCalledWith('2026-11-12')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('"Limpar" tira a data; sem data, não há o que limpar', async () => {
    const first = setup('2026-10-01')
    await first.user.click(first.opener())
    await first.user.click(within(calendar()).getByRole('button', { name: 'Limpar' }))
    expect(first.onChange).toHaveBeenCalledWith(undefined)
    first.unmount()

    const second = setup()
    await second.user.click(second.opener())
    expect(within(calendar()).getByRole('button', { name: 'Limpar' })).toBeDisabled()
  })

  it('clicar fora fecha sem mudar nada', async () => {
    const { user, opener, onChange } = setup('2026-11-05')
    await user.click(opener())
    await user.click(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('o botão abre e fecha; um segundo clique no botão fecha', async () => {
    const { user, opener } = setup('2026-11-05')
    await user.click(opener())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.click(opener())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('com data impossível digitada, o calendário abre no mês de hoje', async () => {
    const { user, input, opener } = setup()
    await user.type(input(), '31022026')
    await user.click(opener())
    expect(title()).toBe('novembro de 2026')
  })
})

describe('o calendário pelo teclado', () => {
  it('ao abrir, o foco vai para o dia escolhido; sem dia, para hoje', async () => {
    const withValue = setup('2026-11-05')
    await withValue.user.click(withValue.opener())
    expect(day('5 de novembro')).toHaveFocus()
    withValue.unmount()

    const without = setup()
    await without.user.click(without.opener())
    expect(day('12 de novembro')).toHaveFocus()
  })

  it('só o dia em foco entra na ordem do Tab (os outros ficam para as setas)', async () => {
    const { user, opener } = setup('2026-11-05')
    await user.click(opener())
    expect(day('5 de novembro')).toHaveAttribute('tabindex', '0')
    expect(day('6 de novembro')).toHaveAttribute('tabindex', '-1')
  })

  it('setas andam: um dia na horizontal, uma semana na vertical', async () => {
    const { user, opener } = setup('2026-11-05')
    await user.click(opener())
    await user.keyboard('{ArrowRight}')
    expect(day('6 de novembro')).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(day('13 de novembro')).toHaveFocus()
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(day('11 de novembro')).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(day('4 de novembro')).toHaveFocus()
  })

  it('passar do fim do mês vira o mês', async () => {
    const { user, opener } = setup('2026-11-30')
    await user.click(opener())
    await user.keyboard('{ArrowRight}')
    expect(title()).toBe('dezembro de 2026')
    expect(day('1 de dezembro de 2026')).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(title()).toBe('novembro de 2026')
    expect(day('30 de novembro')).toHaveFocus()
  })

  it('Home e End vão ao começo e ao fim da semana; PageUp e PageDown trocam o mês', async () => {
    const { user, opener } = setup('2026-11-05')
    await user.click(opener())
    await user.keyboard('{Home}')
    expect(day('domingo, 1 de novembro')).toHaveFocus()
    await user.keyboard('{End}')
    expect(day('sábado, 7 de novembro')).toHaveFocus()
    await user.keyboard('{PageDown}')
    expect(title()).toBe('dezembro de 2026')
    expect(day('7 de dezembro')).toHaveFocus()
    await user.keyboard('{PageUp}{PageUp}')
    expect(title()).toBe('outubro de 2026')
  })

  it('PageDown em 31 de outubro cai no último dia de novembro', async () => {
    const { user, opener } = setup('2026-10-31')
    await user.click(opener())
    await user.keyboard('{PageDown}')
    expect(title()).toBe('novembro de 2026')
    expect(day('30 de novembro')).toHaveFocus()
  })

  it('Enter escolhe o dia em foco, fecha e devolve o foco ao botão', async () => {
    const { user, opener, onChange } = setup('2026-11-05')
    await user.click(opener())
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenCalledWith('2026-11-12')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener()).toHaveFocus()
  })

  it('Esc fecha sem escolher, devolve o foco ao botão e não chega ao que está por baixo (a gaveta)', async () => {
    const seen = vi.fn()
    const spy = (event: KeyboardEvent) => seen(event.key, event.defaultPrevented)
    window.addEventListener('keydown', spy)
    try {
      const { user, opener, onChange } = setup('2026-11-05')
      await user.click(opener())
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(onChange).not.toHaveBeenCalled()
      expect(opener()).toHaveFocus()
      expect(seen).toHaveBeenCalledWith('Escape', true)
    } finally {
      window.removeEventListener('keydown', spy)
    }
  })

  it('Esc com o calendário fechado segue o caminho de quem está por baixo', async () => {
    const seen = vi.fn()
    const spy = (event: KeyboardEvent) => seen(event.key, event.defaultPrevented)
    window.addEventListener('keydown', spy)
    try {
      const { user, input } = setup('2026-11-05')
      await user.click(input())
      await user.keyboard('{Escape}')
      expect(seen).toHaveBeenCalledWith('Escape', false)
    } finally {
      window.removeEventListener('keydown', spy)
    }
  })

  it('o Tab fica dentro do calendário enquanto ele está aberto', async () => {
    const { user, opener } = setup('2026-11-05')
    await user.click(opener())
    const inside: string[] = []
    for (let step = 0; step < 6; step++) {
      await user.tab()
      expect(calendar()).toContainElement(document.activeElement as HTMLElement)
      inside.push(document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '')
    }
    expect(inside).toContain('Mês anterior')
    expect(inside).toContain('Hoje')
  })

  it('o botão do campo abre com Enter e com Espaço', async () => {
    const { user, opener } = setup('2026-11-05')
    opener().focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await user.keyboard(' ')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('texto do calendário', () => {
  it('nenhum texto do calendário usa travessão', async () => {
    const { user, opener } = setup('2026-11-05')
    await user.click(opener())
    expect(calendar().textContent).not.toContain('—')
    expect(opener().getAttribute('aria-label')).not.toContain('—')
  })
})

describe('as contas de data (src/lib/br-date.ts)', () => {
  it.each([
    ['', ''],
    ['0', '0'],
    ['05', '05'],
    ['051', '05/1'],
    ['0511', '05/11'],
    ['05112', '05/11/2'],
    ['05112026', '05/11/2026'],
    ['051120269', '05/11/2026'],
    ['5/', '05/'],
    ['5/1', '05/1'],
    ['5/1/', '05/01/'],
    ['5/1/2026', '05/01/2026'],
    ['05/11/2026', '05/11/2026'],
    ['05.11.2026', '05/11/2026'],
    ['05-11-2026', '05/11/2026'],
    ['2026-11-05', '05/11/2026'],
    ['2026-1-5', '05/01/2026'],
    ['  05/11/2026  ', '05/11/2026'],
    ['ab', ''],
    ['/', ''],
  ])('maskBrDay(%j) = %j', (raw, masked) => {
    expect(maskBrDay(raw)).toBe(masked)
  })

  it('parseBrDay devolve o aaaa-mm-dd, ou o motivo', () => {
    expect(parseBrDay('05/11/2026')).toEqual({ iso: '2026-11-05' })
    expect(parseBrDay('29/02/2028')).toEqual({ iso: '2028-02-29' })
    expect(parseBrDay('31/02/2026')).toEqual({ error: 'missing' })
    expect(parseBrDay('29/02/2027')).toEqual({ error: 'missing' })
    expect(parseBrDay('00/11/2026')).toEqual({ error: 'missing' })
    expect(parseBrDay('05/13/2026')).toEqual({ error: 'missing' })
    expect(parseBrDay('05/11/1899')).toEqual({ error: 'year' })
    expect(parseBrDay('05/11/2101')).toEqual({ error: 'year' })
    expect(parseBrDay('05/11')).toEqual({ error: 'incomplete' })
    expect(parseBrDay('')).toEqual({ error: 'incomplete' })
  })

  it('formatBrDay vai de aaaa-mm-dd para dd/mm/aaaa, e vazio fica vazio', () => {
    expect(formatBrDay('2026-11-05')).toBe('05/11/2026')
    expect(formatBrDay(undefined)).toBe('')
    expect(formatBrDay('')).toBe('')
  })
})
