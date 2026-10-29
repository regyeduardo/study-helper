// Prompts of the "Ata" pipeline. Levantamento de tarefas = stack/relatorio-v2.md (it19, ≈ 90,5),
// literal, plus a generic rule on product names in ENTENDER and at most 2 prints per task.
// Single-pass parts (Resumo, Perguntas em aberto, Linha do tempo, 1:1) = BASE + part, from modelos.ts.
// Generic: no fact of any specific meeting. Placeholders in {{chaves}} are filled by the pipeline.

// Pass 0a: where is the shared work area (vision, whole screen, a few frames; median box)
export const AREA = `Esta é a gravação da tela de quem participava de uma chamada de vídeo. Ache a ÁREA DE TRABALHO COMPARTILHADA: o retângulo da tela que alguém está apresentando (o conteúdo de trabalho: site, sistema, planilha, documento, código), SEM a moldura do app de chamada, painéis laterais, quadros de vídeo dos participantes, barras do navegador de quem gravou, avisos e barra de controles da chamada. Devolva SOMENTE um JSON: {"caixa": [x1, y1, x2, y2], "o_que_e": "uma frase"} com coordenadas de 0 a 1000 (x da esquerda para a direita, y de cima para baixo). Se ninguém estiver compartilhando, devolva {"caixa": null}.`

// Pass 0b: read each distinct crop of the work area (vision)
export const LER_TELA = `Esta imagem é um recorte da tela que alguém compartilhou numa reunião. Transcreva o conteúdo de trabalho que dá para ler, copiando os textos EXATAMENTE como estão escritos (não traduza, não corrija, não complete). Ignore o cursor e qualquer avatar ou foto de pessoa por cima.
Devolva SOMENTE um JSON:
{"programa": "site, sistema ou programa (pelo logotipo ou pelo endereço)",
 "endereco": "URL visível, ou ''",
 "tela": "título da página, tela, arquivo ou aba ativa",
 "caminho": "menu > item > aba ativa, como aparece escrito, ou ''",
 "secoes": ["títulos de cards, blocos, seções ou colunas visíveis"],
 "campos": [{"rotulo": "rótulo do campo", "valor": "valor exibido"}],
 "cartao": null,
 "lista": ["linhas de lista, tabela ou menu aberto, literais"],
 "botoes_e_abas": ["botões, abas e opções visíveis"],
 "resumo": "uma frase: o que esta tela mostra"}
"campos": até 30 pares, só com valor legível. "lista": até 20 linhas.
Se a tela for um cartão ou tarefa de um quadro de tarefas (Trello, Jira, etc.), troque null por {"numero": "", "titulo": "", "descricao": "texto da descrição, literal", "responsaveis": [""], "inicio": "", "prazo": "", "status": "", "revisor_ou_homologacao": "", "projeto": ""}.
Se não houver conteúdo de trabalho legível (só papel de parede, área vazia, tela carregando), devolva {"vazio": true, "resumo": "o que aparece"}.`

const ASR = `A transcrição é automática e erra: troca palavras de som parecido (siglas, nomes de sistemas, termos técnicos, nomes de pessoas; nomes de produtos, ferramentas e empresas costumam virar palavras comuns de som parecido), inventa frases curtas soltas que ninguém disse ("Tchau", "Obrigado", "Amém", "Legenda por ...") e às vezes troca o falante no meio de uma frase. O que está ESCRITO na tela vale mais que o que foi ouvido.`

// Pass 1: context brief + glossary (text, whole meeting)
export const ENTENDER = `Você prepara o CONTEXTO de uma reunião gravada, para que depois se extraiam as tarefas dela. Você recebe: os dados da reunião, as falas ("mm:ss | Nome: texto", nomes reais já resolvidos) e a LEITURA DA TELA compartilhada ("mm:ss | ...", lida de imagens; textos literais, mas a leitura também pode errar um dígito ou letra).
${ASR}
Devolva SOMENTE um JSON:
{"assunto": "tema da reunião em poucas palavras, com o nome do projeto",
 "contexto": "3 a 5 frases: qual sistema ou produto, para qual cliente, de qual empresa é cada participante, o que foi mostrado, que problema apareceu e o que ficou combinado no fim",
 "pessoas": [{"nome": "nome completo como escrito na tela ou dito", "papel": "o que faz neste projeto ou reunião", "participou": true, "prova": "mm:ss e o quê"}],
 "telas": [{"nome": "nome da tela como escrito", "caminho": "menu > item > aba", "o_que_tem": "blocos, campos e valores importantes", "momentos": ["mm:ss"]}],
 "cartoes": [{"numero": "#000", "titulo": "", "responsaveis": [""], "prazo": "dd/mm/aaaa", "descricao": "", "momento": "mm:ss"}],
 "glossario": [{"termo": "forma correta", "ouvido_como": ["como a transcrição escreveu"], "significado": "explicação curta em palavras simples", "prova": "mm:ss: onde aparece escrito, ou por que é a forma certa"}],
 "erros_de_leitura_da_tela": [{"lido": "", "certo": "", "prova": "outros quadros onde aparece certo"}]}
Regras:
- "pessoas": inclua também quem foi só citado (cliente, chefe, outra equipe), com "participou": false. Em "papel", diga de que lado está (quem faz o sistema ou o cliente) e o que faz; não chame de cliente quem cobra a equipe em nome do cliente sem prova.
- "cartoes": só cartões que aparecem na leitura da tela. Se o mesmo cartão aparece com número ou título diferente em quadros diferentes, use a forma que mais se repete e registre a outra em "erros_de_leitura_da_tela".
- "glossario": todo termo do sistema, sigla ou conceito do negócio que alguém de fora precisa entender para executar as tarefas (10 a 25 termos), e TODA palavra que a transcrição escreveu errado e que você consegue corrigir pela tela ou pelo contexto (inclusive nomes de produtos e ferramentas citados, e palavras que não fazem sentido no contexto: diga a forma provável). Em "significado", explique como para um novato, em uma frase. Não liste como correção o que já está certo.
- Produtos e ferramentas: quando uma palavra comum ou um nome de pessoa aparece onde só cabe uma ferramenta, um produto ou um serviço ("faz tudo no X", "eu tenho o X", "perguntei pro X", "foi no X"), quase sempre é o nome de um produto conhecido de som parecido (assistente de IA, planilha, sistema, app). Escreva o nome certo do produto em "termo", ponha a forma ouvida em "ouvido_como" e "provável" na prova. Nunca invente um produto novo a partir da palavra ouvida.
- Não invente. Se uma correção for só provável, escreva "provável" na prova.`

// Pass 2: candidate tasks per chunk (text)
export const CANDIDATAS = `Você acha as TAREFAS num trecho de uma reunião gravada. Você recebe o CONTEXTO (participantes, telas, cartões e glossário), as falas do trecho ("mm:ss | Nome: texto") e a leitura da tela compartilhada naquele trecho.
${ASR}
Tarefa = algo que alguém vai fazer DEPOIS da reunião e que gera uma entrega: mudar uma tela, criar um cálculo, corrigir uma regra, preparar uma explicação, mandar algo para alguém, conseguir uma decisão.
Pegue:
- o que alguém assumiu ("vou fazer", "vou puxar", "deixa comigo");
- o que foi pedido a alguém, mesmo sem resposta, inclusive pedidos em forma de "sugestão" ou de pergunta que exige preparar uma resposta ("o que isso faz?" repetido = pedido de explicação);
- o que estava num cartão de tarefas na tela e foi comentado (com número, título, responsáveis e prazo do cartão);
- o que ficou para depois sem dono.
- regra de negócio dita sobre o sistema ("tem que ser X", "não pode Y", "tem que partir de Z"): vira tarefa de fazer o sistema seguir a regra;
- frases no imperativo dirigidas à equipe ("coloca", "pega", "joga", "mostra", "soma", "cria"), inclusive as que começam com "uma sugestão";
- uma pessoa propõe como fazer e outra confirma ("é isso aí", "isso"): é um combinado.
Seja EXAUSTIVO: leia fala por fala e, na dúvida, inclua (outra etapa filtra). Uma candidata por entrega: se a mesma fala pede duas coisas diferentes, faça duas.
Palavras como "aqui", "isso", "essa tabelinha", "ali" apontam para o que estava aberto na tela naquele segundo: use a leitura da tela para dizer qual tela, aba ou linha era.
NÃO pegue: o que já está feito e só foi mostrado; pergunta respondida na hora; demonstração feita durante a reunião; conversa sobre a própria reunião; "vou ver" sem objeto.
Devolva SOMENTE um JSON:
{"tarefas": [{"o_que": "verbo no infinitivo + entrega específica (qual tela, campo, regra ou cálculo)",
  "detalhes": "regras, valores, datas e exemplos ditos ou vistos na tela",
  "pedida_por": "nome real de quem pediu",
  "dono": "nome real de quem vai fazer, só se a fala ou o cartão na tela deixam claro; senão ''",
  "prova_dono": "a fala ou o cartão que prova o dono",
  "prazo": "como foi dito ('amanhã', 'sexta', '30/10') ou como está no cartão; '' se nada",
  "minuto": "mm:ss da fala principal",
  "citacao": "trecho LITERAL curto dessa fala, copiado da transcrição",
  "outros_minutos": ["mm:ss de outras falas sobre a mesma tarefa"],
  "situacao": "aceita (alguém assumiu) | pedida (pediram, ninguém confirmou) | incerta (ficou no ar ou houve opiniões diferentes)",
  "tela": "tela, aba, campo ou cartão relacionado, como escrito na leitura da tela"}]}
Use sempre os nomes reais e os termos corretos do glossário (na "citacao" mantenha o texto literal). Nunca "Você" nem "Falante".`

// Pass 3a: merge, drop, order (text, all candidates)
export const JUNTAR = `Você organiza as tarefas candidatas de uma reunião, achadas trecho a trecho (por isso há repetidas). Você recebe o CONTEXTO, os dados da reunião e as candidatas numeradas (c1, c2, ...).
1. JUNTE as que são a mesma entrega (mesmo resultado final), mesmo com palavras diferentes. Uma tarefa = UMA ENTREGA que alguém vai receber ou conferir: uma tela, um cálculo, uma correção de regra, uma explicação, um envio. Requisitos e detalhes de uma entrega (salvar em tabela, recalcular quando algo muda, mostrar mês a mês, aceitar todas as opções, separar por abas, priorizar, "focar nisso") são PASSOS dela, não tarefas. Os itens de um mesmo cartão de tarefa da tela são UMA tarefa (o cartão). Pedido de explicar uma função + pedido de corrigir a regra dessa mesma função = UMA tarefa. SEPARE quando são entregas diferentes (ex.: duas telas; desenhar e aprovar um mock-up antes de construir; a regra de uma linha e a regra de outra linha).
2. CLASSIFIQUE cada grupo:
   - "tarefas": há um pedido claro (alguém pediu, sugeriu ou assumiu) e uma entrega definida. Pergunta repetida de quem cobra a entrega ("o que isso faz?") é pedido de explicação: é tarefa, mesmo sem dono. Regra dita para o sistema seguir ("tem que ser X") também;
   - "sem_dono": precisa de ação ou decisão, mas ninguém pediu claramente nem assumiu (divergência que ficou sem decisão, menção de passagem, reclamação de alguém de fora);
   - "descartadas": trivial, já feito, pergunta respondida na hora (e aceita por quem perguntou), demonstração feita na reunião, cartão mostrado na tela de que ninguém falou, ou não é tarefa. NÃO descarte o que vai acontecer depois ("vou mandar", "pode mandar depois que fizer") nem uma explicação que quem pediu não aceitou (continuou perguntando ou disse que não entendeu).
3. ORDENE "tarefas": primeiro as que têm prazo (a mais cedo primeiro; uma tarefa que precisa estar pronta antes de outra vem antes dela), depois as sem prazo, na ordem em que apareceram.
Devolva SOMENTE um JSON:
{"tarefas": [{"titulo": "verbo no infinitivo + entrega, curto e específico", "candidatas": ["c1", "c4"], "momentos": ["mm:ss"], "depende_de": "título de outra tarefa, ou ''"}],
 "sem_dono": [{"assunto": "o que ficou sem dono, numa frase", "candidatas": ["c7"], "momentos": ["mm:ss"]}],
 "descartadas": [{"candidatas": ["c9"], "motivo": "curto"}]}
Toda candidata aparece exatamente uma vez. Uma reunião de 25 minutos costuma ter de 6 a 10 tarefas reais; não infle a lista com tarefas triviais nem parta uma entrega em passos.`

// Pass 3a': critic over the merged list (text, small input)
export const REVISAR = `Você revisa a lista de tarefas de uma reunião antes de ela virar documento. A lista veio de uma etapa que às vezes parte uma entrega em pedaços. Você recebe o contexto e a lista numerada; cada tarefa traz a tela ou o cartão a que se refere, as falas e as falas em volta da primeira (para saber de que parte da tela ela trata).
Para cada tarefa, decida:
- "fica": é uma entrega própria, que alguém vai fazer e outra pessoa vai conferir. Contam como entrega: mudar uma tela, um menu ou uma regra; criar uma visão nova; calcular algo; desenhar um mock-up para aprovar; explicar uma função a quem pediu; enviar algo a alguém; preparar uma resposta para o cliente.
- "passo_de": é só um requisito ou detalhe de OUTRA tarefa da lista que trata da MESMA tela (mesmo nome de tela ou cartão) ou do MESMO cálculo, e ninguém conferiria em separado (ex.: salvar o resultado do cálculo, recalcular quando algo muda, aceitar todas as opções do cálculo, mostrar o resultado mês a mês). Diga de qual ("de": número). Também é "passo_de" a tarefa repetida (mesma entrega com outras palavras) e, quando outra tarefa pede para explicar uma função, tudo o que é sobre essa mesma função: corrigir a regra dela, mostrar na tela como ela funciona, preparar respostas sobre ela.
- "sai": priorizar ou "focar" em algo, verificar algo que já funciona, cartão mostrado na tela de que ninguém falou, algo já feito, demonstração feita na reunião. Nunca é "sai" uma tarefa em que alguém disse que vai fazer ("vou ...") ou que alguém pediu e ninguém disse que já está feita.
Compare os nomes das telas: telas diferentes (por exemplo, uma tela de tabela e uma tela de curva, ou um menu) são entregas diferentes. Mudar a regra de uma linha, etapa ou campo é entrega diferente de mudar a regra de outra linha, etapa ou campo da mesma tela, mesmo que as duas sejam ligadas à mesma função. Calcular sem e com um ajuste são entregas diferentes quando há cartões diferentes.
Se uma tarefa tem alguém que disse que vai fazer ("vou ...") e a outra não, são entregas diferentes: "fica".
Decida cada tarefa só pela tela e pelas falas dela, comparando com as outras; não mire um número de tarefas.
Devolva SOMENTE um JSON válido, sem texto antes ou depois, com exatamente uma decisão por tarefa, na ordem da lista (n = 1, 2, 3, ... até a última):
{"decisoes": [{"n": 1, "decisao": "fica", "de": 0, "motivo": "até 12 palavras, citando a tela"}]}
"decisao" é exatamente uma destas palavras: "fica", "passo_de" ou "sai". "de" é um número inteiro: o número da tarefa-mãe quando "passo_de", senão 0.`

// Pass 3b: targeted look at the frame of the exact second (vision, work-area crop)
export const VER_TAREFA = `Recorte da tela compartilhada no minuto {{minuto}} de uma reunião. Nesse momento falavam disto: "{{titulo}}". Fala: "{{citacao}}".
Olhe a imagem e responda SOMENTE um JSON:
{"tela": "nome da tela, página, arquivo ou cartão, como escrito",
 "caminho": "menu > item > aba ativa, se visível",
 "relacionados": [{"elemento": "aba | campo | card | botão | coluna | linha | valor | menu", "texto": "texto exato na tela", "valor": "valor exibido, se houver", "por_que": "como se liga ao assunto"}],
 "cartao": null,
 "nada_a_ver": false}
Se for um cartão de tarefa, troque null por {"numero": "", "titulo": "", "descricao": "", "responsaveis": [""], "prazo": "", "revisor_ou_homologacao": ""}. Copie os textos exatamente como estão. Se nada na tela tem a ver com o assunto, "nada_a_ver": true.`

// Pass 3c: verify one task (text)
export const VERIFICAR = `Você VERIFICA uma tarefa de uma reunião antes de ela entrar no levantamento. Você recebe: os dados da reunião (data e calendário), o CONTEXTO, a lista de todas as tarefas (para referência), a tarefa a verificar com as candidatas que a originaram, as falas exatas em volta de cada momento e do fechamento da reunião (onde costumam ser ditos os combinados finais: um aceite dito ali vale para todas as tarefas a que ele se refere), a leitura da tela naquele trecho, o que se viu na tela no segundo exato, e o catálogo de telas da reunião (para escolher prints).
${ASR}
Decida com prova, sem inventar:
- O QUE FOI PEDIDO: releia as falas e confirme o pedido exato. "Aqui", "isso", "essa tabelinha", "ali" apontam para a tela aberta naquele segundo (veja o que se viu na tela no segundo exato). Se a candidata entendeu errado, corrija o título e os passos.
- A QUEM: "ele", "pra ele" numa fala entre participantes costuma ser uma terceira pessoa que não está na reunião (o cliente ou o chefe citado antes), não um participante. Se não der para provar quem é, diga em a_confirmar.
- PROVA NA FALA: toda tarefa precisa de uma FALA (não texto lido na tela) em que alguém pede, assume, cobra ou discute ESTA entrega. Copie em "prova_fala" o minuto, quem falou e um trecho LITERAL dessa fala. Não vale: texto de cartão, campo ou título lido na tela; fala sobre outro assunto no mesmo minuto; "isso aqui" quando a tela aberta naquele segundo era outra. Se não houver essa fala, "manter": false e "prova_fala": null.
- MANTER: false se for cartão que só apareceu na tela sem que ninguém pedisse nada sobre ele, se for trivial, já feito, demonstração feita na própria reunião, repetida de outra tarefa da lista ou só um passo/detalhe de outra tarefa da lista. Explicação dada na reunião só conta como feita se quem pediu aceitou; se continuou perguntando ("a pergunta é simples", "não me responde"), a tarefa continua. O que vai acontecer depois ("vou mandar", "depois que fizer") não está feito.
- DONO: só nomeie quem (a) disse que faz ou pediu permissão para fazer e ouviu sim, (b) foi chamado pelo nome para fazer e não recusou, ou (c) está como responsável no cartão da tela. "Você" sem nome não prova dono: quem estava falando ou compartilhando a tela não é prova. Sugerir como fazer, confirmar um detalhe ou responder uma pergunta NÃO é assumir a tarefa. Sem prova: "a confirmar" e diga em dono_prova quem é o mais provável e por quê.
- PRAZO (no máximo 8 palavras): data absoluta (dd/mm/aaaa) só se foi dito ("amanhã", "sexta", uma data) ou está no cartão; converta pelo calendário. Se depende de outra tarefa: "depois da tarefa N"; se tem que estar pronta antes de outra (desenhar ou aprovar antes de construir): "antes da tarefa N". Se só disseram algo vago, copie entre aspas. Senão "sem prazo dito".
- SITUAÇÃO: "aceita" SÓ se o próprio dono disse, com a voz dele, que faz ou que vai fazer ESTA entrega ("vou fazer", "deixa comigo", "vou puxar", "foco nisso", "eu mando"); copie essa fala em "aceite" (minuto, quem = o dono, trecho literal). Quem pediu permissão para fazer ("posso mandar?") e ouviu sim também aceitou: em "aceite" copie a pergunta dele (quem = o dono), não o sim de quem autorizou. NÃO é aceite: o cartão atribuir a pessoa; outra pessoa dizer que ela faz; pergunta sem resposta gravada ("já fez ou vai fazer?"); responder uma dúvida; concordar com um detalhe ("é isso aí", "tá certo"); estar compartilhando a tela. Sem essa fala: "aceite": null e a situação é "pedida" (diga por quem foi pedida ou que o cartão atribui). "incerta": ficou no ar, houve contradição (alguém disse que estava certo e depois outro propôs mudar) ou a resposta não aparece na gravação.
- Use os termos corretos do glossário e os nomes de telas, abas, campos, cartões e valores exatamente como a tela mostra. Quando a tela e a fala discordarem, diga isso em "a_confirmar".
- PASSOS: 2 a 5, o que fazer, concreto, na ordem, com as telas, campos, regras e valores ditos ou vistos (inclua um exemplo numérico se houve). Cite só os campos que a fala ou o cartão nomeiam, no máximo 4 por passo; nunca liste todos os campos de uma seção ou tela (diga o nome da seção). Não invente passos que ninguém disse nem o cartão pede. Se a reunião deu os números de uma conta, escreva a conta com o resultado (ex.: A ÷ B = C). Se um passo depende de algo não decidido, ele vira um passo "confirmar com <nome>".
- BASE: 2 a 4 falas (nunca texto da tela) que provam a tarefa, o dono e o prazo; minuto, quem e citação LITERAL copiados das falas dadas (pode cortar com "..."). Inclua a prova_fala e o aceite, se houve.
- A_CONFIRMAR: tudo o que a gravação não prova (dono, prazo, regra, valor, a quem se refere um "ele"), e palavras da transcrição que parecem erro de áudio (diga a forma provável).
- PRINTS: 1 ou 2 momentos (2 só se mostrarem coisas diferentes) do catálogo de telas que mostram ONDE ou O QUE fazer (o cartão da tarefa, o campo, a tela, o valor). Prefira o segundo em que a tela certa está aberta, mesmo que seja antes ou depois da fala.
Devolva SOMENTE um JSON:
{"manter": true, "motivo": "",
 "prova_fala": {"minuto": "mm:ss", "quem": "Nome", "citacao": "literal"},
 "aceite": null,
 "titulo": "Verbo no infinitivo (com maiúscula) + entrega, até 12 palavras, com o nome da tela ou cartão",
 "dono": "Nome Sobrenome | Nome e Nome | a confirmar", "dono_prova": "",
 "prazo": "", "prazo_prova": "",
 "situacao": "aceita | pedida | incerta", "situacao_detalhe": "até 10 palavras: quem pediu e, se aceita, a palavra-chave do aceite",
 "por_que": "o motivo dito, em 1 ou 2 frases",
 "onde": "sistema > menu > tela > aba > campo; cartão #N 'título'",
 "fatos_da_tela": ["valores, campos e textos lidos na tela que importam para executar"],
 "passos": ["passo concreto"],
 "feito_quando": "o que alguém vê ou confere quando estiver pronto, com o exemplo da reunião se houver",
 "base": [{"minuto": "mm:ss", "quem": "Nome", "citacao": "literal"}],
 "a_confirmar": ["..."],
 "prints": [{"minuto": "mm:ss", "marcar": "o elemento exato a marcar (campo, card, botão, linha, menu)", "legenda": "o que o print mostra, curto"}]}`

// Pass 4a: write one task section (text)
export const ESCREVER_TAREFA = `Você escreve UMA tarefa de um levantamento de tarefas de reunião, em português do Brasil, para alguém que NÃO estava na reunião e precisa executar sem perguntar nada. Você recebe a tarefa verificada (JSON), o glossário e a lista das outras tarefas (para citar "tarefa N" quando uma depende da outra).
Estilo: direto, frases curtas, palavras simples, nada genérico, nada de "é importante", "garantir", "alinhar expectativas". Use os nomes reais e os termos corretos do glossário (o termo ouvido errado só pode aparecer dentro das citações literais). Nunca "Você" nem "Falante". Nunca tabela.
Escreva EXATAMENTE neste formato, sem título, sem nada antes nem depois:

**Dono:** <dono> · **Prazo:** <prazo> · **Situação:** <aceita|pedida|incerta> (<detalhe curto>)

**Por quê:** <1 ou 2 frases>

**Onde:** <sistema > menu > tela > aba > campo; cartão, como escrito na tela>

**Como fazer:**
1. <passo concreto, com valores e nomes da tela>
2. ...

**Feito quando:** <o que se confere quando estiver pronto>

**Base:** [▸ mm:ss] "<citação literal>" · [▸ mm:ss] <Nome>: "<citação literal>"

**A confirmar:** <o que a gravação não prova>

Regras (limites de caracteres contam espaços): 2 a 5 passos, cada um com uma ação só, até 130 caracteres; não repita num passo o que o "Onde" já diz. Não liste todos os campos de uma tela: só os que o passo usa. "Por quê": 1 frase, até 170 caracteres. "Onde": até 170 caracteres, sem endereço web. "Feito quando": 1 frase, até 170 caracteres. "A confirmar": até 170 caracteres; omita a linha se não houver nada. Base: 2 ou 3 falas da base; cada citação com até 100 caracteres, literal, cortada com "..." no meio se preciso. Use [▸ mm:ss] só com os minutos da base. Nomes de pessoas exatamente como na lista de participantes (com acentos). Tamanho total: 700 a 1300 caracteres; se passar, corte palavras e detalhes, nunca valores, resultados de contas, nomes de tela ou citações.`

// Pass 4b: header, unowned items and glossary (text)
export const ESCREVER_GERAL = `Você escreve o começo e o fim de um levantamento de tarefas de reunião, em português do Brasil, para quem não estava na reunião. Você recebe os dados da reunião, o CONTEXTO e a lista final de tarefas (título, dono, prazo).
Estilo: direto, frases curtas, palavras simples. Nomes reais. Nunca "Você" nem "Falante". Nunca tabela.
Devolva SOMENTE um JSON:
{"titulo": "assunto em poucas palavras (projeto / tela), sem a palavra reunião e sem data",
 "contexto": ["linha 1: data, hora, duração, qual sistema e para quem", "linha 2: o que foi mostrado e que problema apareceu", "linha 3: o que ficou combinado no fim, com o prazo"],
 "glossario": [{"termo": "", "significado": "uma frase simples, até 140 caracteres; se a transcrição escreveu errado, diga como ('A transcrição escreve X')"}]}
"contexto": cada linha com até 220 caracteres; só fatos ditos ou vistos (uma dúvida levantada na reunião não é fato).
"glossario": 10 a 18 termos do negócio e do sistema que aparecem nas tarefas ou são necessários para entendê-las, e todas as correções de palavras ouvidas errado que vierem no glossário, inclusive nomes de ferramentas e produtos citados nas falas (diga "A transcrição escreve X", sem atribuir o erro a uma pessoa). Não inclua o app da chamada, o quadro de tarefas nem nomes de pessoas.`

// Pass 4d: what was left without owner, read from the whole meeting (text)
export const PENDENCIAS = `Você acha o que ficou SEM DONO numa reunião gravada: pontos que pedem uma ação ou uma decisão depois da reunião, mas que ninguém pediu claramente a alguém nem assumiu, e que NÃO estão na lista de tarefas já levantadas. Você recebe o contexto, a lista de tarefas (com os minutos das falas de cada uma) e todas as falas ("mm:ss | Nome: texto").
${ASR}
Leia a reunião inteira, do começo ao fim, UMA VEZ PARA CADA tipo abaixo, e preencha cada tipo (lista vazia se não houver):
- "divergencias": como algo foi feito ou deve ser feito, e terminou sem decisão (um fez de um jeito, outro entendeu diferente, ninguém decidiu; "já fiz" não encerra o ponto se outra pessoa disse que entendeu diferente);
- "vai_ter": algo que alguém disse que "vai ter", "também vai ser assim" ou "tem que ter" numa tela ou parte do sistema que NÃO é a tela de nenhuma tarefa da lista, sem pedido a alguém, sem prazo e sem cartão;
- "cobrancas_de_fora": reclamação ou cobrança de alguém de fora da reunião (cliente, chefe, diretoria), contada por um participante, que pede algo que ninguém assumiu fazer;
- "perguntas_abertas": pergunta importante que ficou sem resposta e sem dono.
NÃO inclua: o que foi resolvido na hora, comentário sem consequência, e o que já é tarefa da lista ou detalhe dela. Um item por assunto: todas as falas da base tratam do mesmo assunto e da mesma tela; não misture assuntos vizinhos. Antes de incluir um item, ache na lista a tarefa mais parecida e compare a tela e o pedido: se forem os mesmos, ponha o número dela em "igual_a_tarefa" (o item será descartado); senão 0. Um pedido para explicar, mudar ou mostrar algo que já está na lista é igual a essa tarefa.
Cada item: {"tela": "tela ou parte do sistema de que o item trata", "igual_a_tarefa": 0, "assunto": "nome curto, sem asteriscos", "texto": "1 ou 2 frases curtas: o que é, o que cada um disse, o que falta decidir e com quem", "base": [{"minuto": "mm:ss", "quem": "Nome", "citacao": "trecho LITERAL copiado das falas, até 120 caracteres, cortado com ... e terminando no fim de uma frase ou palavra"}]}
Devolva SOMENTE um JSON: {"divergencias": [], "vai_ter": [], "cobrancas_de_fora": [], "perguntas_abertas": []}
No máximo 2 itens por tipo; cada um com 1 a 3 falas na base. Nomes reais; nunca "Você" nem "Falante".`

// Pass 4c: shorten a task section that came out too long (text)
export const ENCURTAR = `Encurte esta tarefa de um levantamento de reunião para no máximo {{max}} caracteres. Limites: "Por quê", "Onde", "Feito quando" e "A confirmar" com até 170 caracteres cada; cada passo com até 130; cada citação com até 100. Mantenha EXATAMENTE o mesmo formato e os mesmos rótulos em negrito, os nomes, o prazo, a situação, os valores, as telas e as citações literais com [▸ mm:ss]. Corte palavras, repetições, passos óbvios e detalhes que não mudam o que fazer; junte passos parecidos; troque listas de mais de 4 campos pelo nome da seção; tire endereços web; no máximo 5 passos e 3 citações. Devolva só a tarefa encurtada.`

// Pass 5: boxes for a print (vision, work-area crop)
export const MARCAR = `Recorte da tela compartilhada numa reunião. Marque nesta imagem: "{{marcar}}".
Devolva SOMENTE um JSON: {"achou": true, "itens": [{"rotulo": "até 6 palavras", "caixa": [x1, y1, x2, y2]}]}
Caixas em escala 0 a 1000 sobre ESTA imagem (x da esquerda para a direita, y de cima para baixo), justas ao elemento (campo, card, botão, linha, coluna, menu). 1 a 3 itens. Nunca marque avatar, cursor, barra de abas ou de endereço do navegador. Se o elemento não está na imagem, {"achou": false, "itens": []}.`

// ---------------- single-pass parts (BASE + the part), from modelos.ts ----------------
// Differences from modelos.ts: no "> Encaixe" line (it judged the template for the comparison),
// real names always (never "Você"/"Falante N"), the CONTEXTO/glossário of pass 1 as input, and the
// structure/style of the gold answers (gabarito-*.md, 28/10), never their facts.
export const BASE = `Você escreve, em português do Brasil, uma parte da ata de uma reunião gravada, a partir da transcrição e do que apareceu na tela, para quem não estava na reunião.

Você recebe:
- os dados da reunião e o CONTEXTO (pessoas, telas, cartões e o glossário com as palavras que a transcrição escreveu errado);
- as falas, uma por linha: "mm:ss | Nome: texto";
- a leitura da tela: "mm:ss | ...".

Regras:
- Comece com um título "# " específico do assunto (sem a palavra reunião, sem data).
- Cada ponto termina com o minuto da fala que o comprova: [▸ mm:ss]. Use só minutos que existem nas falas. Nada sem prova. Quando ajudar, logo depois do minuto vem a citação LITERAL curta (até 120 caracteres, pode cortar com "..."), com o nome de quem falou: [▸ mm:ss] Nome: "texto". Várias provas separadas por " · ".
- Use sempre o nome real de cada pessoa, como está nas falas ou na tela, com acentos. Nunca escreva "Você" nem "Falante N".
- Use os termos corretos do glossário: a transcrição troca siglas, nomes de sistemas e de ferramentas; o que está escrito na tela vale mais que o que foi ouvido. Se corrigiu palavras dentro das citações, termine com uma linha em itálico: _Nas citações, "X" (erro do áudio) virou Y._
- Quando um ponto fala de algo que estava na tela, ou quando ver a tela ajuda a entender, peça um print numa linha própria, logo abaixo do ponto:
  {{print mm:ss | o que marcar na tela, curto e concreto}}
  Peça no máximo 5 prints, só os que ajudam. Use o minuto exato em que aquilo está na tela.
- Seja específico: nomes, números, datas, valores, telas, cartões e termos como foram ditos ou vistos. Nada genérico ("discutiram melhorias", "é importante").
- Estilo: direto, frases curtas, palavras simples. Diga quem disse o quê e no que deu (aprovou, pediu, ficou sem resposta).
- Não invente o que não foi dito. Se faltar informação para uma seção, escreva "Não apareceu na reunião."
- Markdown limpo: títulos, listas, negrito. Nunca tabela.`

export const RESUMO = `Modelo RESUMO. Título "# " que já diz no que deu (os 2 ou 3 fatos principais numa linha). Logo abaixo, UMA linha: "Reunião de dd/mm/aaaa (dia da semana), N min, sobre <sistema ou projeto> <para quem>." Depois:
"## Em poucas linhas": um parágrafo de até 6 linhas dizendo do que se tratou, o que travou e no que deu, com os minutos.
"## Pontos principais": 5 a 8 itens, os que alguém que faltou precisa saber, cada um "- **<assunto curto: a conclusão.>** <fatos, valores e quem disse o quê, com citações curtas> [▸ mm:ss] ...".
"## Ficou combinado": uma linha por combinado: "- <o quê, com cartão ou tela se houver>: <dono ou 'dono a confirmar'>, <prazo ou 'sem prazo'>. [▸ mm:ss]". Só o que alguém pediu ou assumiu.`

export const PERGUNTAS = `Modelo PERGUNTAS EM ABERTO. Título "# Perguntas em aberto · <assunto>". Logo abaixo, UMA frase dizendo qual foi a maior pergunta e como terminou. Depois:
"## Perguntas sem resposta": lista numerada, da mais importante para a menor. Cada item:
"1. **<a pergunta, como pergunta?>**" e, nas linhas de baixo (recuadas): o que foi perguntado e quantas vezes; "O que foi dito:" as respostas que apareceram (com o que a tela mostrou, se ajuda); "Por que importa:" (se foi dito); "Quem responde:" nome (ou "a confirmar"); e a linha de provas "[▸ mm:ss] "literal" · [▸ mm:ss] Nome: "literal"".
Percorra as falas do começo ao fim e não pare nas primeiras: numa reunião de 25 minutos costuma haver de 8 a 12. Conte como sem resposta: pergunta que ninguém respondeu na gravação (até as curtas, como "já fez?"); resposta que quem perguntou não aceitou; divergência entre duas falas, ou entre uma fala e o que a tela mostra (datas, valores, nomes), que ficou sem decisão; o que alguém disse que vai confirmar com outra pessoa; pedido vago ("depois que fizer", "aquela telinha") sem dizer o quê; dúvida que alguém levantou e ninguém retomou. Uma pergunta por item: não junte perguntas diferentes, nem as repita com outras palavras.
"## Riscos": "- **<o risco numa frase.>** <o que foi dito e o que pode acontecer> [▸ mm:ss] Nome: "literal"". Inclua pendências e bloqueios ditos.`

export const LINHA_DO_TEMPO = `Modelo LINHA DO TEMPO. Título "# Linha do tempo · <assunto>". Logo abaixo, UMA frase (quem compartilhou a tela, o formato). Depois, capítulos em ordem: "### mm:ss · <título do trecho, com o fato principal>" e, embaixo, 1 a 3 frases curtas do que aconteceu (o que foi mostrado, pedido, decidido ou ficou sem resposta), seguidas de 1 a 3 provas "[▸ mm:ss] "literal" · [▸ mm:ss] Nome: "literal"". Um capítulo a cada mudança de assunto ou de tela (numa reunião de 25 minutos, uns 15 a 20). Cubra a reunião inteira, do começo ao fim, sem buracos grandes.`

export const UM_A_UM = `Modelo 1:1. Título "# 1:1 · <quem conduziu> com <quem>: <assuntos>". Logo abaixo, UMA frase dizendo se foi mesmo um 1:1 ou outro tipo de conversa (acompanhamento, cobrança) e como foi. Depois:
"## Como estão as entregas": "- **<entrega> (<dono>): <estado em poucas palavras>.** <detalhe> [▸ mm:ss] Nome: "literal"".
"## Feedback de <nome de quem conduziu>": elogios e cobranças, cada um "- **<o feedback em poucas palavras>.** <explicação> [▸ mm:ss] ...". Inclua feedback recebido, se houve.
"## Contexto que <nome> trouxe": o que foi contado de fora da reunião (cliente, chefe, outra equipe), se houve.
"## Combinados": "- **<o quê>:** <dono>, <prazo>. [▸ mm:ss]".
"## Para a próxima conversa": "- <Nome>: <o que trazer ou responder>". Use "A confirmar:" para o que não tem dono. Varie o começo dos itens: não comece todos com a mesma palavra ("Cobrança:", "Elogio:").`
