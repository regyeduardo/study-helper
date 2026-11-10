# Estudo

App de estudo e reuniões: o que a pessoa traz vira notas, e das notas saem outras notas e o material para estudá-las.

## Language

### O que existe na biblioteca

**Entrada**:
O material de onde uma nota nasce: arquivo, link, mídia (áudio, vídeo, gravação de reunião), texto colado ou tema. É um item próprio da biblioteca, com o nível do que foi guardado (**Só o registro** ou **Registro e arquivo**); continua existindo depois que a mídia é apagada.
_Avoid_: input, fonte, origem

**Transcrição**:
O texto falado de uma mídia, com quem falou e quando. Faz parte da **Entrada** de mídia, não é **Nota**, e continua lá se a mídia for apagada.
_Avoid_: nota de transcrição

**Nota**:
O texto que a pessoa lê, com seus **Metadados**; nasce de uma **Entrada**, de outra **Nota** ou é escrita direto.
_Avoid_: arquivo, documento, item

**Nota filha**:
Uma **Nota** feita a partir de outra **Nota** (ex.: uma Explicação, uma Aula ou uma Ata gerada de uma nota); uma nota tem zero ou várias notas filhas.
_Avoid_: nota derivada, sub-nota

**Artefato**:
O que se gera ou se acumula a partir de uma **Nota** e vive dentro dela, sem virar nota: marcações, mapa mental, histórico do tutor e afins. Uma nota tem vários, cada um com nome.
_Avoid_: anexo, extra, recurso

**Subartefato**:
Um **Artefato** que pertence a outro artefato, e não direto à nota (ex.: a conversa de um mapa mental, guardada com o mapa).
_Avoid_: artefato filho, anexo do artefato

**Metadados**:
Os dados que descrevem a **Nota** (nome, etiquetas, datas, modelo usado); fazem parte da nota e não são **Artefatos**.
_Avoid_: propriedades, info

**Prova**:
O banco único de questões de uma **Nota**, com as tentativas feitas nele; faz parte da nota e não é **Artefato**.
_Avoid_: simulado, quiz, banco de questões

## Relationships

- Uma **Entrada** gera uma ou mais **Notas** e é a raiz delas: as notas feitas dela ficam embaixo dela, e as **Notas filhas** embaixo das notas.
- Uma **Nota** tem zero ou várias **Notas filhas**, e cada nota filha tem uma única nota mãe.
- Uma **Nota** tem zero ou vários **Artefatos**; um artefato pertence a uma única nota.
- Um **Artefato** tem zero ou vários **Subartefatos** (um mapa mental tem a sua conversa); a conversa do Tutor é artefato da nota, não de um mapa.

## Example dialogue

> **Dev:** "A Explicação que a pessoa gerou de um trecho da Aula é um artefato da Aula?"
> **Especialista:** "Não: é texto pra ler, então é uma **Nota filha** da Aula. Já o mapa mental que ela gerou da Aula é um **Artefato** dela, e pode haver outro mapa com outro nome."

## Flagged ambiguities

- "Input" foi usado para **Entrada**. Uma nota escrita direto não é **Entrada**: as notas feitas dela são **Notas filhas**.
