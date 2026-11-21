# Estudo

App de estudo e reuniões: o que a pessoa traz vira notas, e das notas saem outras notas e o material para estudá-las.

## Language

### O que existe na biblioteca

**Nota**:
Tudo o que fica dentro das pastas, com o seu tipo (Aula, Ata, Explicação, Leitura, Vídeo, Áudio, PDF, Link, Texto e os demais) e os seus **Metadados**. Nasce de outra **Nota**, é trazida pela pessoa (um vídeo, um PDF, um link) ou é escrita direto. As que guardam um arquivo têm o nível do que foi guardado (**Só o registro** ou **Registro e arquivo**).
_Avoid_: arquivo, documento, item, entrada

**Nota de mídia**:
Uma **Nota** do tipo Vídeo ou Áudio. Tem a página especial onde se toca a mídia, se transcreve e se veem as **Notas filhas**; continua existindo, marcada como mídia apagada, se a mídia for apagada.
_Avoid_: entrada de mídia, mídia (como item da biblioteca)

**Gravação**:
Uma **Nota de mídia** que o próprio app gravou (reunião, tela ou microfone). Aparece na tela Gravações; um áudio ou vídeo trazido pela pessoa é **Nota de mídia**, mas não é **Gravação**.
_Avoid_: entrada gravada, captura

**Transcrição**:
O texto falado de uma mídia, com quem falou e quando. Faz parte da **Nota de mídia**, não é **Nota** própria, e continua lá se a mídia for apagada.
_Avoid_: nota de transcrição

**Nota filha**:
Uma **Nota** feita a partir de outra **Nota**, de qualquer tipo (ex.: uma Ata gerada de uma **Nota de mídia**, uma Explicação gerada de uma Aula); uma nota tem zero ou várias notas filhas.
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

- Uma **Nota** tem zero ou várias **Notas filhas** (as notas feitas dela), e cada nota filha tem uma única nota mãe; a família pode ter vários níveis (filhas, netas).
- Toda **Gravação** é uma **Nota de mídia**; nem toda **Nota de mídia** é **Gravação**.
- Uma **Nota** tem zero ou vários **Artefatos**; um artefato pertence a uma única nota.
- Um **Artefato** tem zero ou vários **Subartefatos** (um mapa mental tem a sua conversa); a conversa do Tutor é artefato da nota, não de um mapa.

## Example dialogue

> **Dev:** "A Explicação que a pessoa gerou de um trecho da Aula é um artefato da Aula?"
> **Especialista:** "Não: é texto pra ler, então é uma **Nota filha** da Aula. Já o mapa mental que ela gerou da Aula é um **Artefato** dela, e pode haver outro mapa com outro nome."

## Flagged ambiguities

- "Entrada" é termo aposentado (desde 20/11/2026): o que era Entrada (vídeo, áudio, PDF, link, texto colado, tema) agora é **Nota** do seu tipo, e as notas feitas dela são **Notas filhas**. A tela "Entradas" virou "Gravações". "Input" também era usado para Entrada.
- "Gravação" era usada para qualquer áudio ou vídeo (ex.: "Gravações sem transcrição"); agora **Gravação** é só o que o app gravou, e o geral é **Nota de mídia**.
