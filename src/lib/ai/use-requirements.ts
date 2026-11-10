import type { Media } from '@/lib/ai/config'
import type { AiStep, AiUse } from '@/types/domain'

/**
 * What each AI use demands from a model and how the app proves a model does it (FR-049, FR-051).
 * A new AiUse or Ata step needs a declaration here, or src/test/ai/use-requirements.test.ts fails.
 * Source: specs/002-mapas-hierarquia-explorador/mocks/indicacao-de-modelos/pesquisa.md
 */

export type Capability = Media | 'web' | 'json'

/** The typical note a cost is computed from. `hours`: what a model priced by the hour is billed for. */
export interface Ruler {
  /** What one unit is, shown next to the cost ("hora de aula", "conversa", "20 telas"). */
  per: string
  input: number
  output: number
  searches?: number
  hours?: number
}

export interface Expected {
  /** What must be in the answer, in words (goes into the reason of the diagnosis). */
  item: string
  /** Accepted ways of saying it: any one counts (compared without accents or case). */
  accept: string[]
  /** Parts that must come with it, a task's owner and deadline: one list per part, any form counts. */
  together?: string[][]
  /** A result the model must work out, so it is not literally in the material. */
  derived?: boolean
}

/** Audio and video are fixed files, recorded once with a synthetic voice; the screen is drawn from these fields. */
export type Material =
  | { kind: 'texto'; text: string }
  | { kind: 'audio'; file: string; seconds: number; speech: string }
  | { kind: 'video'; file: string; seconds: number; speech: string; slide: string }
  | { kind: 'tela'; width: number; height: number; title: string; topics: string[]; number: string; table: string[][] }
  | { kind: 'busca'; topic: string }

export interface JsonList {
  count: number
  fields?: string[]
  /** Field whose values cannot repeat (or, when it holds several values, repeat among themselves). */
  distinct?: string
}

export type FormatCheck =
  /** Markdown with at least so many headings (the app builds it from the JSON of elements). */
  | { kind: 'markdown'; headings: number }
  | {
      kind: 'json'
      fields: string[]
      lists?: Record<string, JsonList>
      maxWords?: Record<string, number>
      /** A known value in a list: the row matching `where` must have the fields of `is`. */
      exact?: { list: string; where: Record<string, unknown>; is: Record<string, unknown> }[]
    }
  /** The tree of the map (src/lib/generation/mindmap.ts). */
  | { kind: 'tree'; root: string; children: string; text: string; branches: number; leaves: number; maxWords: number }
  | { kind: 'text' }

export interface MiniTest {
  /** What the model is asked, sent together with the material. */
  ask: string
  material: Material
  expected: Expected[]
  /** How many of the expected items are enough (default: all). */
  need?: number
  /** Tempting inventions: none of these can be in the answer. */
  forbidden: string[]
  /** A number that is neither in the material nor in `numbers` counts as invented. */
  strictNumbers?: boolean
  /** Numbers the answer may say beyond those in the material (results of a calculation). */
  numbers?: string[]
  /** The only people who can own something; any other owner is invented. */
  people?: string[]
  format: FormatCheck
  /** "itens": the 50/30/10/10 score. "wer": the score comes from the word error rate. */
  measure: 'itens' | 'wer'
  /** Words heard against a known speech. */
  wer?: { reference: string; max: number }
  /** Characters read against a known screen. */
  cer?: { reference: string; max: number }
  /** The URL of the answer must be among the pages the search read, and the statement must match what was cited. */
  citedUrl?: boolean
  /** Yes-or-no questions for the cheap AI judge, only where automatic checks cannot see clarity. */
  judge?: string[]
}

export interface UseRequirement {
  id: AiUse | AiStep
  needs: Capability[]
  /** Tokens the model must be able to read at once, when the material is long. */
  context?: number
  language: 'pt-BR'
  minScore: number
  /** What the use demands, in the one line shown above its ladder. */
  asks: string
  ruler: Ruler
  altRulers?: Ruler[]
  test: MiniTest
}

/* ---------- the score ---------- */

export const MIN_SCORE = 8
/** Points out of 10. */
export const SCORE_POINTS = { expected: 5, invented: 3, format: 1, ptBr: 1 }
/** Anything invented limits the score to this. */
export const INVENTION_CAP = 6
/** A model this close to the minimum repeats the test once. */
export const RETEST_MARGIN = 1
export const MAX_TRANSCRIPTION_WER = 0.1
/** Words of European Portuguese: one of them in the answer fails the "português do Brasil" check. */
export const PT_PT_MARKS = ['facto', 'equipa', 'utilizador', 'ecrã', 'telemóvel', 'registo', 'ficheiro', 'contacto', 'autocarro', 'pequeno-almoço']

export interface ScoreParts {
  found: number
  expected: number
  inventions: number
  format: boolean
  ptBr: boolean
}

export function scoreOf({ found, expected, inventions, format, ptBr }: ScoreParts): number {
  const items = expected > 0 ? (Math.min(found, expected) / expected) * SCORE_POINTS.expected : 0
  const total = items + (inventions ? 0 : SCORE_POINTS.invented) + (format ? SCORE_POINTS.format : 0) + (ptBr ? SCORE_POINTS.ptBr : 0)
  return Math.min(total, inventions ? INVENTION_CAP : 10)
}

/** 10 for no errors, 9 at a 10% word error rate (pesquisa.md: "WER ≤ 10% → nota 9"). */
export function werScore(wer: number): number {
  return Math.round(Math.max(0, Math.min(10, 10 * (1 - wer))) * 100) / 100
}

/* ---------- the miniature materials: fictional, so the model cannot answer from memory ---------- */

const CAPITULO = `# As salinas de Pedra Branca

Pedra Branca é uma vila do litoral conhecida pelas salinas que ocupam a planície ao sul do rio Jacumã. A água do mar entra na planície pelo canal do Farol, sempre na maré alta, e segue por gravidade até os primeiros tanques.

## Como o sal se forma

A água passa primeiro pelos evaporadores, tanques largos onde o sol e o vento vão retirando a água. O vento nordeste acelera a evaporação e, por isso, os tanques foram abertos no sentido em que ele sopra. O líquido que resta, muito mais salgado, é a salmoura. A salmoura segue então para o cristalizador, um tanque raso de fundo de argila batida onde o sal finalmente se forma. Nas tardes sem vento, uma camada fina e delicada aparece na superfície: é a flor de sal, que só pode ser colhida à mão, com uma peneira.

## A safra

A safra vai de setembro a fevereiro, durante a estação seca. Cada hectare de cristalizador produz em média 48 toneladas de sal por safra. A chuva fora de época é o maior inimigo do salineiro: ela dissolve o sal já formado nos cristalizadores e atrasa a colheita por semanas.

## Quem trabalha nas salinas

Os salineiros se organizam na Cooperativa Maré Mansa, criada por Dona Zulmira Freitas para vender o sal sem atravessadores. A cooperativa guarda o sal em armazéns de madeira, porque o metal enferruja em contato com ele, e decide em assembleia o preço de cada safra.

## A vila antes das salinas

Antes de virar terra de salineiros, Pedra Branca vivia da pesca de tainha e do conserto de redes. As famílias moravam em casas de taipa perto da barra, e os barcos saíam antes do amanhecer. Quando os cardumes rarearam, os mais velhos lembraram que a maré deixava crostas brancas nas pedras da planície, e dali veio o nome da vila. Os primeiros moradores passaram a cavar valas na lama para aprisionar a água do mar e aprenderam, errando muito, quanto tempo cada vala precisava de sol. O conhecimento passou de pai para filho, sem nada escrito, e até hoje os salineiros mais antigos conseguem dizer pelo gosto da água em que ponto ela está.

## O cuidado com os tanques

Manter os tanques dá mais trabalho do que colher o sal. Antes de cada safra, os salineiros raspam o lodo do fundo, consertam as muretas de barro e abrem as comportas de tábua para lavar os canais. Se a mureta cede, a água doce do rio invade o tanque e estraga o trabalho de semanas. O fiscal das comportas, escolhido entre os próprios salineiros, percorre a planície a pé todas as manhãs, e quem encontra um vazamento avisa os vizinhos tocando um sino de bronze. As ferramentas também são simples: rodos de madeira, carrinhos de mão e cestos de palha trançados na própria vila.

## Do tanque à feira

Depois de colhido, o sal descansa em montes à beira dos tanques para escorrer a água que ainda carrega. Em seguida, vai de carroça até os armazéns, onde fica guardado até a venda. Parte da produção sai em sacos grandes para os açougues da região, que usam o sal para conservar carne. A flor de sal, mais cara e mais rara, é vendida em potes pequenos na feira de sábado e nos restaurantes da capital. Os compradores de fora costumam visitar as salinas durante a safra, provam o sal na ponta do dedo e negociam direto com a cooperativa, que anota cada venda num caderno de capa preta guardado pela tesoureira, Dona Iracema Luz.

## Os desafios de hoje

Os filhos dos salineiros têm procurado trabalho na cidade, e a cooperativa teme que faltem braços nas próximas safras. A construção de um porto na enseada vizinha mudou a correnteza e trouxe mais areia para o canal, que agora precisa ser dragado com frequência. Apesar disso, o turismo trouxe uma renda nova: visitantes pagam para caminhar entre os tanques ao entardecer e aprender a colher a flor de sal. Os mais velhos desconfiam dessa novidade, mas reconhecem que ela ajuda a pagar o conserto das comportas.

## A festa do sal

No encerramento de cada safra, a vila faz a Festa do Sal na praça da igreja. Os salineiros levam para a missa um punhado do primeiro sal colhido, que o padre abençoa e devolve às famílias para guardar em casa. Depois da missa, a banda toca na rua, as barracas vendem peixe assado na brasa e os mais jovens disputam uma corrida de carrinhos de mão carregados de areia. À noite, os mais velhos contam histórias sobre a maré que trouxe o sal, e as crianças ouvem sentadas nos degraus da igreja. A festa é organizada por um grupo de voluntárias que se reúne na casa de Dona Zulmira, e é nessa época que os desentendimentos do ano costumam ser resolvidos, quase sempre em torno de uma mesa farta.

## O sal na cozinha da vila

Na cozinha de Pedra Branca, o sal grosso tempera o peixe logo depois da pesca, e a flor de sal só vai à mesa no último instante, sobre o alimento pronto, para estalar entre os dentes. As cozinheiras dizem que o sal da vila é menos agressivo do que o sal refinado que chega das fábricas, porque guarda um pouco do gosto do mar. O prato mais conhecido é a tainha na crosta de sal: o peixe inteiro é coberto por uma camada úmida, assado no forno de barro e aberto na frente dos convidados com uma pancada de colher de pau. Quem visita a vila costuma levar para casa um pote de flor de sal e a receita escrita num pedaço de papel pardo.`

const FATOS: Expected[] = [
  { item: 'as salinas ficam ao sul do rio Jacumã', accept: ['jacumã'] },
  { item: 'a água entra pelo canal do Farol', accept: ['canal do farol'] },
  { item: 'o vento nordeste acelera a evaporação', accept: ['vento nordeste', 'nordeste'] },
  { item: 'a safra vai de setembro a fevereiro', accept: ['setembro a fevereiro', 'setembro até fevereiro', 'setembro e fevereiro'] },
  { item: 'a chuva fora de época dissolve o sal e atrasa a colheita', accept: ['chuva fora de época', 'chuvas fora de época', 'chuva fora de hora', 'chuva dissolve', 'chuvas dissolvem'] },
  { item: 'os salineiros se organizam na Cooperativa Maré Mansa', accept: ['maré mansa'] },
  { item: 'a cooperativa foi criada por Dona Zulmira Freitas', accept: ['zulmira'] },
  { item: 'o sal é guardado em armazéns de madeira', accept: ['armazéns de madeira', 'armazém de madeira'] },
]

const TERMOS: Expected[] = [
  { item: 'salmoura: o líquido muito salgado que resta', accept: ['salmoura'] },
  { item: 'cristalizador: o tanque raso onde o sal se forma', accept: ['cristalizador'] },
  { item: 'flor de sal: a camada fina colhida à mão', accept: ['flor de sal'] },
]

const NUMERO: Expected = { item: '48 toneladas de sal por hectare, por safra', accept: ['48 toneladas', '48 t'] }

// Compared by substring, so never a piece of a common word ("iodo" is in "período"). Invented years are caught by `strictNumbers`.
const CAPITULO_INVENCOES = ['mossoró', 'rio grande do norte', 'iodado', 'século']

const AULA = `Bom pessoal, antes de começar, quem faltou na terça pega a folha de exercícios comigo no fim. Silêncio aí no fundo, por favor. Então, hoje a gente vai falar de bacia hidrográfica. A gente vinha falando de ciclo da água, lembram? A chuva cai, uma parte infiltra no solo, outra parte escorre pela superfície, e é essa parte que escorre que interessa hoje. Bacia hidrográfica é toda a área de terra cuja água da chuva escorre para um mesmo rio. Anotem isso. Imaginem uma bacia de lavar roupa, daquelas de plástico. Se vocês jogarem água em qualquer ponto da borda, ela desce e se junta no fundo. É exatamente por isso que o nome é bacia. O terreno funciona do mesmo jeito, só que em tamanho gigante, e o fundo da bacia é o rio. Alguém perguntou se toda chuva vira rio? Não, boa pergunta. Uma parte evapora, outra parte é absorvida pelas plantas e outra entra no solo e fica guardada por muito tempo. Mas o que não infiltra vai descendo morro abaixo, vai formando enxurrada, e as enxurradas procuram sempre o caminho mais baixo. Bom, continuando. Onde o rio começa, a gente chama de nascente. Onde ele termina, encontrando outro rio ou o mar, é a foz. Olha, muita gente confunde as duas coisas, então guardem assim: a água sempre desce do começo até o fim, nunca o contrário. Parece bobo, mas tem aluno que desenha o rio subindo a serra. Os rios menores que despejam água no rio principal são os afluentes. Pensem numa árvore deitada: o tronco é o rio principal e os galhos são os rios menores chegando nele. Quando vocês olharem o mapa da região no livro, tentem seguir um galho até o tronco com o dedo, e na semana que vem eu quero ver todo mundo com o livro na carteira, combinado? E o que separa uma bacia da outra são as partes altas do relevo, o divisor de águas. Se a chuva cai de um lado do divisor, vai para uma bacia; se cai do outro lado, vai para a outra. Quem já subiu a serra do Cambará viu isso na prática: lá em cima tem uma estrada de terra que corre bem no alto, e a água que cai de um lado da estrada vai para um vale, a que cai do outro vai para o vale vizinho. O seu Dirceu, que é agricultor lá e veio conversar com a turma do ano passado, dizia que a água da chuva escolhe a sua família na hora que toca o chão. Achei uma imagem bonita. Agora vamos a um exemplo aqui da nossa região. O córrego do Ipê nasce na serra do Cambará e deságua no rio Jacumã, então ele é um afluente do Jacumã. Quando desmatam a beira do córrego, a terra solta desce com a chuva e vai enchendo o fundo do leito. Esse problema tem nome: assoreamento. O rio fica raso e transborda com mais facilidade. E não é só uma questão de o rio ficar feio. Quando o leito sobe, o peixe some, a água fica barrenta, o barco não passa, e na época de chuva a água invade a rua de quem mora perto. O bairro da Várzea, aqui na cidade, sofreu com isso até pouco tempo atrás, e a prefeitura gastou muito dinheiro para retirar terra do fundo do córrego. Retirar terra resolve por um tempo, mas, se a beira continuar desmatada, a terra volta na chuva seguinte. Prestem atenção, porque isso cai na prova de quinta-feira: assoreamento e a diferença entre nascente e foz. Alguma dúvida? Pode falar. Não, isso a gente vê na próxima. Semana que vem tem trabalho em dupla, escolham a dupla até lá. Na próxima aula a gente continua.`

const JUROS = 'Um capital de R$ 1.000, aplicado a juros compostos de 10% ao ano, vira R$ 1.210 depois de 2 anos.'

const FEIRA = 'Feira de Ciências da Escola Ipê-Amarelo. Inscrição: o prazo termina na sexta-feira e cada grupo tem até quatro alunos. Montagem: as bancadas ficam no ginásio e as tomadas só existem na parede norte. Avaliação: os jurados são professores convidados e os critérios são originalidade e clareza.'

const EMENTA = `Curso livre: Planilhas para pequenos negócios

Módulo 1. Primeiros passos com planilhas. Carga horária: 8 h. Células, linhas e colunas, formatação e impressão.
Módulo 2. Fórmulas e funções do dia a dia. Carga horária: 12 h. Soma, média, procura de valores e condições.
Módulo 3. Gráficos e painéis de vendas. Carga horária: 10 h. Gráficos de barra e de linha, painéis de acompanhamento.
Módulo 4. Controle de estoque e caixa. Carga horária: 10 h. Entradas, saídas, fluxo de caixa e fechamento do mês.`

const REUNIAO = `00:00 | Marta: Bom dia, gente. Reunião rápida sobre o cardápio de Natal da Trigo Bom. Quero sair daqui com o que entra e quem faz o quê.
00:12 | Joel: Eu trouxe a ideia do panetone de cupuaçu. Fiz duas fornadas de teste e o pessoal da loja gostou.
00:25 | Bruna: Os clientes perguntam desde outubro. Acho que vende bem.
00:33 | Marta: Então está decidido: o panetone de cupuaçu entra no cardápio de Natal.
00:41 | Joel: Combinado. Mas a receita ainda está doce demais. Eu fecho a receita final até sexta-feira, dia 28.
00:52 | Marta: Fechado, Joel, sexta, dia 28. E as encomendas? Ano passado foi um caos no telefone.
01:04 | Bruna: Minha proposta é receber encomenda só pelo WhatsApp da loja. Fica tudo escrito.
01:15 | Marta: Concordo. Decidido: este ano, encomenda só pelo WhatsApp, nada de telefone.
01:24 | Bruna: Então eu monto o cardápio com os preços e publico no Instagram da padaria até segunda-feira, dia 1º de dezembro.
01:36 | Marta: Ótimo. Eu fico com as embalagens: fecho o pedido com o fornecedor até quarta-feira, dia 26, senão não chega a tempo.
01:49 | Joel: E as entregas nos fins de semana de dezembro? O Seu Antônio, que fazia, se aposentou.
01:58 | Bruna: Eu não consigo, fico no balcão.
02:03 | Marta: Eu também não. Precisamos de alguém, mas hoje não dá para resolver.
02:10 | Joel: Fica em aberto, então.
02:14 | Marta: Fica. Recapitulando: panetone de cupuaçu no cardápio, encomenda só pelo WhatsApp. Joel fecha a receita até sexta, dia 28; Bruna publica o cardápio até segunda, dia 1º; eu fecho as embalagens até quarta, dia 26. As entregas de fim de semana ainda não têm dono.
02:40 | Bruna: Perfeito.
02:43 | Joel: Até mais.`

const LISTA_TAREFAS = `Lista de tarefas:
1. Fechar a receita final do panetone de cupuaçu (Joel, sexta-feira, dia 28)
2. Reduzir o açúcar da receita do panetone de cupuaçu (Joel, sexta-feira, dia 28)
3. Publicar o cardápio no Instagram (Bruna, segunda-feira, dia 1º de dezembro)
4. Fechar o pedido de embalagens (Marta, quarta-feira, dia 26)`

const DONOS = ['Marta', 'Joel', 'Bruna']

const DECISOES: Expected[] = [
  { item: 'decisão: o panetone de cupuaçu entra no cardápio de Natal', accept: ['panetone de cupuaçu'] },
  { item: 'decisão: encomenda só pelo WhatsApp', accept: ['whatsapp'] },
]

const TAREFAS: Expected[] = [
  { item: 'Joel fecha a receita final até sexta-feira, dia 28', accept: ['receita'], together: [['joel'], ['28']] },
  { item: 'Bruna publica o cardápio no Instagram até segunda-feira, dia 1º de dezembro', accept: ['instagram'], together: [['bruna'], ['1º', '1/12', '01/12', 'primeiro de dezembro', 'segunda']] },
  { item: 'Marta fecha o pedido de embalagens até quarta-feira, dia 26', accept: ['embalagens'], together: [['marta'], ['26']] },
]

const PENDENCIA: Expected = { item: 'as entregas dos fins de semana de dezembro ficaram sem dono', accept: ['entregas'] }

const REUNIAO_INVENCOES = ['motoboy', 'transportadora', 'antônio vai', 'antônio fica', 'dia 30']

const FALA_TRANSCRICAO = 'Bom dia turma toda. Hoje vamos revisar o capítulo sobre as salinas do litoral. A professora Lúcia Andrade lembrou que cada hectare de cristalizador produz quarenta e oito toneladas de sal por safra. Tragam o resumo escrito até sexta-feira porque na próxima aula teremos um debate curto sobre o assunto.'

const FALA_VIDEO = 'A reunião de pais da Escola Ipê-Amarelo foi marcada para quinta-feira, às sete da noite, no auditório.'

const SLIDE_VIDEO = 'Reunião de pais · Escola Ipê-Amarelo · Quinta-feira, 19h'

const TELA = {
  kind: 'tela' as const,
  width: 1280,
  height: 720,
  title: 'Feira de Ciências · Escola Ipê-Amarelo',
  topics: ['Inscrição até sexta-feira', 'Montagem no ginásio', 'Avaliação por professores convidados'],
  number: 'Projetos inscritos: 37',
  table: [
    ['7º B', '12 projetos', 'Laboratório 2'],
    ['8º A', '25 projetos', 'Ginásio'],
  ],
}

/** The text a material carries: what the answer key is compared with. */
export function materialText(material: Material): string {
  if (material.kind === 'texto') return material.text
  if (material.kind === 'audio') return material.speech
  if (material.kind === 'video') return `${material.slide}\n${material.speech}`
  if (material.kind === 'busca') return material.topic
  return [material.title, ...material.topics, material.number, ...material.table.flat()].join('\n')
}

/* ---------- the declarations ---------- */

/** Long material: a whole note, three hours of class or of a meeting. */
const LONG_CONTEXT = 128_000

const texto = (text: string): Material => ({ kind: 'texto', text })

type Declaration = Omit<UseRequirement, 'id' | 'language' | 'minScore'> & { minScore?: number }

const declare = <Id extends AiUse | AiStep>(id: Id, declaration: Declaration): UseRequirement => ({ id, language: 'pt-BR', minScore: MIN_SCORE, ...declaration })

export const USE_REQUIREMENTS: Record<AiUse, UseRequirement> = {
  estudo: declare('estudo', {
    needs: ['texto'],
    context: LONG_CONTEXT,
    asks: 'texto longo, português do Brasil, Markdown',
    ruler: { per: 'nota', input: 12_000, output: 4_000 },
    test: {
      ask: 'Faça a nota de estudo deste capítulo em Markdown, com títulos, em português do Brasil. Inclua os fatos, os termos com o seu significado e os números do texto. Não acrescente nada que não esteja nele.',
      material: texto(CAPITULO),
      expected: [...FATOS, ...TERMOS, NUMERO],
      forbidden: CAPITULO_INVENCOES,
      strictNumbers: true,
      format: { kind: 'markdown', headings: 2 },
      measure: 'itens',
      judge: ['Alguém que não leu o capítulo entenderia a nota?', 'As ideias estão organizadas numa ordem que faz sentido?'],
    },
  }),
  aula: declare('aula', {
    needs: ['texto'],
    context: LONG_CONTEXT,
    asks: 'texto longo, português do Brasil, Markdown',
    ruler: { per: 'hora de aula', input: 15_000, output: 5_000 },
    test: {
      ask: 'Transforme esta aula transcrita numa aula em Markdown, com títulos, em português do Brasil. Mantenha os conceitos, o exemplo e os avisos do professor. Não acrescente nada que não tenha sido dito.',
      material: texto(AULA),
      expected: [
        { item: 'nascente: onde o rio começa', accept: ['nascente'] },
        { item: 'foz: onde o rio termina', accept: ['foz'] },
        { item: 'afluentes: rios menores que despejam no principal', accept: ['afluente'] },
        { item: 'divisor de águas: as partes altas que separam as bacias', accept: ['divisor de águas'] },
        { item: 'assoreamento: a terra solta enche o fundo do leito', accept: ['assoreamento'] },
        { item: 'o exemplo do córrego do Ipê', accept: ['córrego do ipê'] },
        { item: 'o aviso: cai na prova de quinta-feira', accept: ['prova de quinta', 'na prova'] },
      ],
      forbidden: ['são francisco', 'amazonas', 'tietê', 'mata ciliar'],
      strictNumbers: true,
      format: { kind: 'markdown', headings: 2 },
      measure: 'itens',
      judge: ['Alguém que faltou à aula entenderia o que é assoreamento?', 'O aviso de prova está fácil de achar?'],
    },
  }),
  explicacao: declare('explicacao', {
    needs: ['texto'],
    asks: 'clareza em português do Brasil',
    ruler: { per: 'nota', input: 8_000, output: 3_000 },
    test: {
      ask: 'Explique este trecho passo a passo, em Markdown, em português do Brasil, para quem não sabe o que são juros compostos.',
      material: texto(JUROS),
      expected: [
        { item: 'parte de R$ 1.000 a 10% ao ano', accept: ['1.000', '1000'] },
        { item: 'no primeiro ano vira R$ 1.100', accept: ['1.100', '1100'], derived: true },
        { item: 'no segundo ano os juros incidem sobre R$ 1.100', accept: ['sobre 1.100', 'sobre r$ 1.100', 'sobre os 1.100', 'juros sobre juros', 'sobre o novo'], derived: true },
        { item: 'os juros somam R$ 210', accept: ['r$ 210', 'r$210', '210 de juros', '210 reais'], derived: true },
        { item: 'o resultado é R$ 1.210', accept: ['1.210', '1210'] },
      ],
      forbidden: ['1.331', 'selic', 'ipca'],
      strictNumbers: true,
      numbers: ['1.100', '1100', '1,1', '1,10', '1,21', '100', '110', '121', '200', '210', '1.200', '1200', '0,1', '0,10'],
      format: { kind: 'markdown', headings: 1 },
      measure: 'itens',
      judge: ['Alguém sem base em matemática entenderia a explicação?', 'Cada passo decorre do anterior?'],
    },
  }),
  prova: declare('prova', {
    needs: ['texto', 'json'],
    asks: 'JSON confiável',
    ruler: { per: 'nota', input: 10_000, output: 4_000 },
    test: {
      ask: 'Crie 5 questões de múltipla escolha sobre este capítulo, em português do Brasil. Responda SOMENTE um JSON: {"questoes": [{"enunciado": "...", "alternativas": {"A": "...", "B": "...", "C": "...", "D": "..."}, "correta": "A"}]}. A resposta certa precisa estar no texto.',
      material: texto(CAPITULO),
      expected: FATOS,
      need: 5,
      forbidden: CAPITULO_INVENCOES,
      format: { kind: 'json', fields: ['questoes'], lists: { questoes: { count: 5, fields: ['enunciado', 'alternativas', 'correta'], distinct: 'alternativas' } } },
      measure: 'itens',
    },
  }),
  web: declare('web', {
    needs: ['texto', 'web', 'json'],
    asks: 'pesquisa na web',
    ruler: { per: 'nota', input: 9_000, output: 3_000, searches: 1 },
    test: {
      ask: 'Pesquise na web agora uma questão real do ENEM sobre fotossíntese e responda SOMENTE um JSON: {"url": "<endereço da página onde a questão está>", "enunciado": "<o enunciado, copiado da página>"}. Se você não consegue pesquisar na web, responda {"url": null}.',
      material: { kind: 'busca', topic: 'fotossíntese' },
      expected: [{ item: 'a questão é sobre fotossíntese', accept: ['fotossíntese'] }],
      forbidden: [],
      citedUrl: true,
      format: { kind: 'json', fields: ['url', 'enunciado'] },
      measure: 'itens',
    },
  }),
  cartoes: declare('cartoes', {
    needs: ['texto', 'json'],
    asks: 'JSON',
    ruler: { per: 'nota', input: 10_000, output: 3_000 },
    test: {
      ask: 'Faça 8 cartões de memorização deste capítulo, em português do Brasil, sem repetir assunto. O verso sai do texto. Responda SOMENTE um JSON: {"cartoes": [{"frente": "...", "verso": "..."}]}.',
      material: texto(CAPITULO),
      expected: [...FATOS, ...TERMOS],
      need: 8,
      forbidden: CAPITULO_INVENCOES,
      format: { kind: 'json', fields: ['cartoes'], lists: { cartoes: { count: 8, fields: ['frente', 'verso'], distinct: 'frente' } } },
      measure: 'itens',
    },
  }),
  mapa: declare('mapa', {
    needs: ['texto', 'json'],
    asks: 'a árvore do mapa em JSON, sem quebrar',
    ruler: { per: 'nota', input: 10_000, output: 2_000 },
    test: {
      ask: 'Faça o mapa deste texto, em português do Brasil. Responda SOMENTE um JSON: {"nome": "...", "forma": "arvore", "raiz": {"texto": "...", "filhos": [{"texto": "...", "filhos": [{"texto": "..."}]}]}}. Um ramo por assunto, com frases de até 12 palavras.',
      material: texto(FEIRA),
      expected: [
        { item: 'o prazo termina na sexta-feira', accept: ['sexta'] },
        { item: 'cada grupo tem até quatro alunos', accept: ['quatro alunos', '4 alunos'] },
        { item: 'as bancadas ficam no ginásio', accept: ['ginásio'] },
        { item: 'as tomadas só existem na parede norte', accept: ['parede norte'] },
        { item: 'os jurados são professores convidados', accept: ['professores convidados'] },
        { item: 'os critérios são originalidade e clareza', accept: ['originalidade'] },
      ],
      forbidden: ['troféu', 'medalha', 'premiação', 'prêmio'],
      format: { kind: 'tree', root: 'raiz', children: 'filhos', text: 'texto', branches: 3, leaves: 2, maxWords: 12 },
      measure: 'itens',
    },
  }),
  tutor: declare('tutor', {
    needs: ['texto'],
    context: LONG_CONTEXT,
    asks: 'conversa em que a nota volta a cada pergunta',
    ruler: { per: 'conversa', input: 85_000, output: 4_000 },
    test: {
      ask: 'Responda às 3 perguntas usando só a nota abaixo, em português do Brasil. Se a nota não cobre uma pergunta, diga que isso não está na nota.\n1. Em que meses vai a safra?\n2. Como é colhida a flor de sal?\n3. Quanto custa o quilo do sal de Pedra Branca?',
      material: texto(CAPITULO),
      expected: [
        { item: 'a safra vai de setembro a fevereiro', accept: ['setembro a fevereiro', 'setembro até fevereiro', 'setembro e fevereiro'] },
        { item: 'a flor de sal é colhida à mão', accept: ['à mão', 'manualmente'] },
        { item: 'avisa que o preço não está na nota', accept: ['não está na nota', 'a nota não diz', 'a nota não informa', 'não consta na nota', 'não aparece na nota', 'nota não menciona', 'nota não traz'], derived: true },
      ],
      forbidden: ['r$', 'reais o quilo', 'reais por quilo', 'por quilo custa'],
      strictNumbers: true,
      format: { kind: 'text' },
      measure: 'itens',
    },
  }),
  curso: declare('curso', {
    needs: ['texto', 'json'],
    context: LONG_CONTEXT,
    asks: 'texto longo',
    ruler: { per: 'nota', input: 20_000, output: 4_000 },
    test: {
      ask: 'Olhe a estrutura desta ementa e diga se é um curso com vários módulos. Responda SOMENTE um JSON: {"is_course": true, "name": "...", "description": "uma frase, com a carga horária total do curso", "modules": [{"title": "...", "start": "as primeiras palavras do trecho, copiadas", "end": "as últimas palavras do trecho, copiadas"}]}.',
      material: texto(EMENTA),
      expected: [
        { item: 'módulo: primeiros passos com planilhas', accept: ['primeiros passos'] },
        { item: 'módulo: fórmulas e funções', accept: ['fórmulas e funções'] },
        { item: 'módulo: gráficos e painéis', accept: ['gráficos e painéis'] },
        { item: 'módulo: controle de estoque e caixa', accept: ['estoque'] },
        { item: 'a carga total é de 40 horas', accept: ['40 h', '40h', '40 horas'], derived: true },
      ],
      forbidden: ['microsoft excel', 'no excel', 'certificado', 'macros', 'vba'],
      strictNumbers: true,
      numbers: ['40'],
      format: { kind: 'json', fields: ['is_course', 'name', 'description', 'modules'], lists: { modules: { count: 4, fields: ['title', 'start', 'end'] } } },
      measure: 'itens',
    },
  }),
  titulo: declare('titulo', {
    needs: ['texto', 'json'],
    asks: 'resposta curta',
    ruler: { per: 'nota', input: 3_000, output: 100 },
    test: {
      ask: 'Dê um título de até 8 palavras e 3 etiquetas para este texto, em português do Brasil. Responda SOMENTE um JSON: {"titulo": "...", "etiquetas": ["...", "...", "..."]}.',
      material: texto(CAPITULO),
      expected: [
        { item: 'salinas', accept: ['salinas', 'salina'] },
        { item: 'sal marinho', accept: ['sal marinho', 'produção de sal', 'extração de sal'], derived: true },
        { item: 'evaporação', accept: ['evaporação'] },
        { item: 'cooperativa', accept: ['cooperativa', 'cooperativismo'] },
        { item: 'Pedra Branca', accept: ['pedra branca'] },
      ],
      need: 2,
      forbidden: CAPITULO_INVENCOES,
      format: { kind: 'json', fields: ['titulo', 'etiquetas'], lists: { etiquetas: { count: 3 } }, maxWords: { titulo: 8 } },
      measure: 'itens',
    },
  }),
  midia: declare('midia', {
    needs: ['video', 'audio'],
    context: 1_000_000,
    asks: 'ouve áudio e vê vídeo',
    ruler: { per: 'hora de vídeo', input: 1_000_000, output: 5_000 },
    altRulers: [{ per: 'hora de áudio', input: 115_000, output: 5_000 }],
    test: {
      ask: 'Assista a este vídeo. Responda SOMENTE um JSON: {"fala": "o que é dito, palavra por palavra", "slide": "o texto que aparece no slide"}.',
      material: { kind: 'video', file: 'diagnostico/video-15s.webm', seconds: 15, speech: FALA_VIDEO, slide: SLIDE_VIDEO },
      expected: [
        { item: 'o nome da escola, no slide', accept: ['ipê-amarelo', 'ipê amarelo'] },
        { item: 'o horário, no slide', accept: ['19h', '19 h', '19:00'] },
        { item: 'o auditório, dito na fala', accept: ['auditório'] },
      ],
      forbidden: ['ginásio', 'sexta-feira'],
      format: { kind: 'json', fields: ['fala', 'slide'] },
      measure: 'itens',
      wer: { reference: FALA_VIDEO, max: 0.15 },
    },
  }),
  transcricao: declare('transcricao', {
    needs: ['audio'],
    minScore: werScore(MAX_TRANSCRIPTION_WER),
    asks: 'ouve áudio, com poucos erros em português',
    // `hours` bills the speech models; the tokens are for a model that hears through the chat (about 15k of transcript per hour).
    ruler: { per: 'hora de áudio', hours: 1, input: 115_000, output: 15_000 },
    test: {
      ask: 'Transcreva este áudio em português do Brasil, palavra por palavra.',
      material: { kind: 'audio', file: 'diagnostico/fala-20s.mp3', seconds: 20, speech: FALA_TRANSCRICAO },
      expected: [
        { item: 'o nome próprio', accept: ['lúcia andrade'] },
        { item: 'o número', accept: ['quarenta e oito', '48'] },
      ],
      forbidden: [],
      format: { kind: 'text' },
      measure: 'wer',
      wer: { reference: FALA_TRANSCRICAO, max: MAX_TRANSCRIPTION_WER },
    },
  }),
  tela: declare('tela', {
    needs: ['imagem'],
    asks: 'vê imagem e lê o texto',
    ruler: { per: '20 telas', input: 24_000, output: 3_000 },
    test: {
      ask: 'Transcreva todo o texto desta tela, exatamente como está escrito, sem traduzir, corrigir ou completar.',
      material: TELA,
      expected: [
        { item: 'o título', accept: ['ipê-amarelo', 'ipê amarelo'] },
        { item: 'tópico: inscrição até sexta-feira', accept: ['sexta-feira'] },
        { item: 'tópico: montagem no ginásio', accept: ['montagem no ginásio'] },
        { item: 'tópico: professores convidados', accept: ['professores convidados'] },
        { item: 'o número de projetos', accept: ['37'] },
        { item: 'a tabela: Laboratório 2', accept: ['laboratório 2'] },
        { item: 'a tabela: 25 projetos', accept: ['25 projetos'] },
      ],
      forbidden: ['38', 'laboratório 3'],
      strictNumbers: true,
      format: { kind: 'text' },
      measure: 'itens',
      // pesquisa.md does not give a limit: the same 10% as the transcription.
      cer: { reference: materialText(TELA), max: 0.1 },
    },
  }),
  ata: declare('ata', {
    needs: ['texto', 'json'],
    context: LONG_CONTEXT,
    asks: 'ler a reunião inteira, tarefas com dono e prazo em JSON, português do Brasil',
    // The five steps rereading the excerpts, as in the wireframes; the second is the 1 h ruler pesquisa.md was asked for.
    ruler: { per: 'hora de reunião', input: 50_000, output: 8_000 },
    altRulers: [{ per: 'hora de reunião, sem reler', input: 15_000, output: 3_000 }],
    test: {
      ask: 'Leia esta reunião e responda SOMENTE um JSON, em português do Brasil: {"decisoes": ["..."], "tarefas": [{"o_que": "...", "dono": "...", "prazo": "..."}], "sem_dono": ["o que ficou sem dono"]}. Não invente dono nem prazo.',
      material: texto(REUNIAO),
      expected: [...DECISOES, ...TAREFAS, PENDENCIA],
      forbidden: REUNIAO_INVENCOES,
      strictNumbers: true,
      people: DONOS,
      format: { kind: 'json', fields: ['decisoes', 'tarefas', 'sem_dono'], lists: { tarefas: { count: 3, fields: ['o_que', 'dono', 'prazo'] } } },
      measure: 'itens',
    },
  }),
}

// How the five steps split the Ata's 50k/8k is an estimate: pesquisa.md only gives the total.
export const STEP_REQUIREMENTS: Record<AiStep, UseRequirement> = {
  contexto: declare('contexto', {
    needs: ['texto', 'json'],
    context: LONG_CONTEXT,
    asks: 'entender a reunião inteira e devolver em JSON quem participou e do que se tratou',
    ruler: { per: 'passo', input: 10_000, output: 1_500 },
    test: {
      ask: 'Prepare o contexto desta reunião, em português do Brasil. Responda SOMENTE um JSON: {"assunto": "...", "contexto": "3 a 5 frases", "pessoas": [{"nome": "...", "papel": "...", "participou": true}]}. Inclua quem só foi citado, com "participou": false.',
      material: texto(REUNIAO),
      expected: [
        { item: 'o assunto: o cardápio de Natal', accept: ['cardápio de natal'] },
        { item: 'Marta participou', accept: ['marta'] },
        { item: 'Joel participou', accept: ['joel'] },
        { item: 'Bruna participou', accept: ['bruna'] },
        { item: 'o Seu Antônio só foi citado', accept: ['antônio'] },
      ],
      forbidden: REUNIAO_INVENCOES,
      format: { kind: 'json', fields: ['assunto', 'contexto', 'pessoas'], lists: { pessoas: { count: 4, fields: ['nome', 'papel', 'participou'] } } },
      measure: 'itens',
    },
  }),
  tarefas: declare('tarefas', {
    needs: ['texto', 'json'],
    asks: 'achar as tarefas com dono e prazo, em JSON, sem inventar',
    ruler: { per: 'passo', input: 15_000, output: 2_500 },
    test: {
      ask: 'Ache as tarefas desta reunião: o que alguém vai fazer depois dela. Responda SOMENTE um JSON, em português do Brasil: {"tarefas": [{"o_que": "...", "dono": "...", "prazo": "..."}]}. Não invente dono nem prazo. Deixe de fora o que ficou sem dono.',
      material: texto(REUNIAO),
      expected: TAREFAS,
      forbidden: REUNIAO_INVENCOES,
      strictNumbers: true,
      people: DONOS,
      format: { kind: 'json', fields: ['tarefas'], lists: { tarefas: { count: 3, fields: ['o_que', 'dono', 'prazo'] } } },
      measure: 'itens',
    },
  }),
  revisar: declare('revisar', {
    needs: ['texto', 'json'],
    asks: 'decidir em JSON o que é entrega própria e o que é só um passo de outra',
    ruler: { per: 'passo', input: 8_000, output: 1_500 },
    test: {
      ask: 'Revise a lista de tarefas desta reunião. Para cada tarefa, decida: "fica" (entrega própria), "passo_de" (detalhe de outra tarefa da lista; diga qual em "de") ou "sai". Responda SOMENTE um JSON: {"decisoes": [{"n": 1, "decisao": "fica", "de": 0}]}, com uma decisão por tarefa.',
      material: texto(`${REUNIAO}\n\n${LISTA_TAREFAS}`),
      expected: [
        { item: 'a tarefa 2 é passo da tarefa 1', accept: ['passo_de'], derived: true },
        { item: 'as tarefas 1, 3 e 4 ficam', accept: ['fica'] },
      ],
      forbidden: [],
      format: {
        kind: 'json',
        fields: ['decisoes'],
        lists: { decisoes: { count: 4, fields: ['n', 'decisao', 'de'] } },
        exact: [
          { list: 'decisoes', where: { n: 1 }, is: { decisao: 'fica' } },
          { list: 'decisoes', where: { n: 2 }, is: { decisao: 'passo_de', de: 1 } },
          { list: 'decisoes', where: { n: 3 }, is: { decisao: 'fica' } },
          { list: 'decisoes', where: { n: 4 }, is: { decisao: 'fica' } },
        ],
      },
      measure: 'itens',
    },
  }),
  semdono: declare('semdono', {
    needs: ['texto', 'json'],
    context: LONG_CONTEXT,
    asks: 'achar em JSON o que ficou sem dono, sem dar dono a ninguém',
    ruler: { per: 'passo', input: 10_000, output: 1_000 },
    test: {
      ask: 'Ache o que ficou SEM DONO nesta reunião: o que pede uma ação depois dela, mas ninguém assumiu. Responda SOMENTE um JSON, em português do Brasil: {"sem_dono": [{"assunto": "...", "texto": "..."}]}.',
      material: texto(REUNIAO),
      expected: [PENDENCIA],
      forbidden: [...REUNIAO_INVENCOES, 'bruna assumiu', 'joel assumiu', 'marta assumiu', 'bruna ficou responsável', 'joel ficou responsável', 'marta ficou responsável'],
      strictNumbers: true,
      format: { kind: 'json', fields: ['sem_dono'], lists: { sem_dono: { count: 1, fields: ['assunto', 'texto'] } } },
      measure: 'itens',
    },
  }),
  escrever: declare('escrever', {
    needs: ['texto'],
    asks: 'escrever a ata em português do Brasil, com dono e prazo certos',
    ruler: { per: 'passo', input: 7_000, output: 1_500 },
    test: {
      ask: 'Escreva a ata desta reunião em Markdown, em português do Brasil, com as seções Decisões, A fazer (o quê, quem, até quando) e Em aberto. Não invente dono nem prazo.',
      material: texto(REUNIAO),
      expected: [...DECISOES, ...TAREFAS, PENDENCIA],
      forbidden: REUNIAO_INVENCOES,
      strictNumbers: true,
      people: DONOS,
      format: { kind: 'markdown', headings: 2 },
      measure: 'itens',
    },
  }),
}

export function requirementOf(id: AiUse | AiStep): UseRequirement {
  return (USE_REQUIREMENTS as Record<string, UseRequirement>)[id] ?? (STEP_REQUIREMENTS as Record<string, UseRequirement>)[id]
}
