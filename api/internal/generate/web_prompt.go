package generate

// webQuestionsPrompt is the instruction of the Questões da web (src/lib/generation/web-questions.ts, WEB_QUESTIONS_PROMPT); a test says
// when the two drift apart.
const webQuestionsPrompt = `Você pesquisa na web questões REAIS de prova sobre o assunto do material abaixo, para a pessoa
treinar com elas.

## ONDE PROCURAR
Provas e listas publicadas: vestibulares, ENEM, concursos, OAB, provas de faculdade, certificações,
olimpíadas, bancos de questões, em qualquer idioma.

## O QUE TRAZER
- Só questões que você achou de fato numa página nesta pesquisa. Nunca invente questão, gabarito ou endereço.
- Só questões do assunto do material. As que fogem dele ficam de fora.
- Não há número fixo: traga todas as boas que achar. Se não achar nenhuma, devolva {"questions": []}.
- Questão em outro idioma: traduza tudo (enunciado, alternativas, explicação) para o português do Brasil.
- Fora a tradução, o enunciado e as alternativas ficam como na fonte.
- Pule a questão que depende de figura ou gráfico que não dá para escrever em texto. Tabela vai em markdown.
- Gabarito: use o oficial da fonte; sem gabarito na fonte, resolva e confira antes de marcar.
- "explicacao": por que a resposta certa é a certa, em poucas frases.
- "fonte": o endereço completo (https://...) da página onde a questão está.

## FORMATO DE SAÍDA
Responda com UM objeto JSON, sem cercas de markdown e sem texto fora do JSON:
{"questions": [ ...questões... ]}

Cada questão vira um destes tipos:
- unica (4 ou 5 alternativas, como na fonte, uma certa): {"tipo": "unica", "enunciado": "...",
  "alternativas": {"A": "...", "B": "...", "C": "...", "D": "...", "E": "..."}, "correta": "B",
  "explicacao": "...", "fonte": "https://..."}
  Se a original tem 4 alternativas, mantenha as 4, de "A" a "D", sem "E".
- multipla (marque todas, de 2 a 4 certas): igual à unica, trocando "correta" por "corretas": ["A", "D"].
- certo_errado (uma afirmação para julgar): {"tipo": "certo_errado", "enunciado": "...", "certo": true,
  "explicacao": "...", "fonte": "https://..."}
Questão aberta ou de outro formato fica de fora.

Tudo em português do Brasil, menos o endereço da fonte. Devolva apenas JSON válido.
`

// WebQuestionsPrompt is the instruction of the Questões da web.
func WebQuestionsPrompt() string { return webQuestionsPrompt }
