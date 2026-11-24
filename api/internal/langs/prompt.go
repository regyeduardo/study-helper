package langs

import (
	"fmt"
	"strings"
)

// Prompt is what the AI gets for one piece of a text (prototipo/SCHEMA.md, v2): the piece, the items the language already has (to reuse
// their ids) and the rules of the format. Everything the person answers is closed: the app grades it by itself, no AI judges.
func Prompt(languageName, code string, piece []string, known []BaseItem, ready []ReadyItem, n, of int) string {
	var b strings.Builder
	fmt.Fprintf(&b, `You write study material for a Brazilian who is learning a language (%s, code "%s") from a text they chose (a song, an article, a dialogue...).
This is piece %d of %d of the text. Teach EVERYTHING a learner needs to fully understand and use the language of this piece, from every area of the CEFR, not only words.
All explanations, meanings and questions ("q", "meaning", "expl", "facets", options in Portuguese) are in Brazilian Portuguese. "qEn" is the same question in %s.

THE PIECE:
%s

`, languageName, code, n, of, languageName, strings.Join(piece, "\n"))
	if len(ready) > 0 {
		b.WriteString("READY ITEMS (already written and shared; id | label | kind). When this piece uses one, put its id in \"reuse\" and do NOT write it in \"items\"; \"needs\" and \"covers\" may point to it:\n")
		for _, item := range ready {
			fmt.Fprintf(&b, "%s | %s | %s\n", item.ID, item.Label, item.Kind)
		}
		b.WriteString("\n")
	}
	if len(known) > 0 {
		b.WriteString("ITEMS THIS PERSON ALREADY HAS (id | label | kind). When this piece uses one, use THE SAME id (never a new id for the same thing) and put it in \"items\" with its test cards:\n")
		for _, item := range known {
			fmt.Fprintf(&b, "%s | %s | %s\n", item.ID, item.Label, item.Kind)
		}
		b.WriteString("\n")
	}
	b.WriteString(promptRules)
	return b.String()
}

const promptRules = `ANSWER with ONE JSON object only (no text around it), with these keys:
{
  "equivalences": [["won't", "will not"], ["gonna", "going to"]],   // forms that say the same thing, lower case: only the ones this piece uses or that confuse
  "reuse": ["give_up"],              // ids of READY ITEMS this piece uses (not written again)
  "items": {
    "<id>": {                        // id: lower case letters, digits and _ ("give_up", "mind_v"); the same thing in another text has the same id
      "area": "lexico",              // lexico | gramatica | semantica | fonologia | ortografia | registro | pragmatica
      "kind": "phrasal_verb",        // word | fixed_expression | phrasal_verb | idiom | collocation | structure | contraction | spoken_form | sense | sound | stress | linking | spelling | register | function | discourse
      "label": "give up",            // how it shows in the card
      "say": "give up",              // optional: what the voice says, when different from label
      "meaning": "desistir",         // in Portuguese
      "word": "give", "pattern": "give up + -ing", "core": "...",   // REQUIRED when kind is "sense": the mother word, the pattern that identifies the sense, the central sense that links the others
      "expl": "...",                 // explanation in Portuguese
      "ex": ["Don't give up! = Não desista!"],
      "needs": ["give", "up"],       // ids it needs to be known before (no cycles)
      "facets": {"spoken": "...", "written": "...", "parts": "...", "meaning": "...", "senses": "...", "associations": "...", "grammar": "...", "collocations": "...", "use": "..."},  // only the ones that matter
      "test": [ 2 or 3 closed cards that prove the item, of different types; AT LEAST ONE is a listening card (listen_mc, dictation or dictation_gap). They are shared with other people: use your own example sentences, NEVER a sentence of the piece ]
    }
  },
  "practice": [ closed cards made from THE SENTENCES OF THE PIECE; each one is solved by itself, without remembering the text. MOST ARE LISTENING CARDS (see LISTENING below) ],
  "context":  [ closed comprehension cards about the piece (Day & Park), each with "dp": literal | reorganizacao | inferencia | previsao | avaliacao ]
}

CARD: common fields "id" (unique in the whole answer), "type", "skill" (read | listen | speak), "q" (the question in Portuguese), "qEn" (optional), "covers" (item ids the card trains), "needs" (item ids needed to understand the question in the studied language), "expl" (shown after answering).
type          fields                                                      skill
mc            opts (exactly 5), a (index of the right one), optsEn?       read
tf            a (true/false); q is the statement                          read
gap           text with exactly one ___, opts (exactly 5), a              read
order         tokens (the pieces, shuffled), answer (the sentence)        read
match         pairs [[left, right], ...] (2 or more)                      read
odd           opts (exactly 5), a (index of the odd one)                  read
listen_mc     say (the sentence the voice says), opts (exactly 5), a     listen
minimal_pair  pair [x, y] (two different words; the app says one)        listen
same_diff     say [x, y], a ("same" or "diff")                            listen
find_diff     text (shown), say (the audio, with ONE word changed), a (index of that word in text, counting words split by spaces)   listen
stress        word, syllables (they make the word together), a (index of the strong syllable)   listen
dictation     say (the sentence to write)                                 listen
dictation_gap say, text (say with ___ for each blank), answers (one list of accepted answers per blank; the blanks filled must give say)   listen
speak         mode (repeat | read | shadow | answer | translate), say?, target, accept []   speak

LISTENING (the person studies by listening): "practice" MUST have, for this piece:
- one "dictation" for EVERY sentence of the piece (say = the sentence exactly as written);
- at least 2 "dictation_gap" (the key words of the piece as blanks);
- at least 1 "find_diff" and 1 "listen_mc" (the meaning of a sentence);
- 1 "minimal_pair" or "same_diff" for each sound of the piece that confuses Brazilians (ship/sheep, walk/work, think/sink);
- 1 "stress" for each word of 3 or more syllables.
Reading cards may come after these.

RULES:
- In "gap" and "dictation_gap" the sentence with the blank goes in "text" with exactly "___" for each blank; "q" only asks ("Complete:").
- Every choice card (mc, gap, listen_mc, odd) has exactly 5 options, with HARD distractors: same class and same field of meaning, near synonyms that do not fit that context, false cognates, look-alike forms (want/won't, used to/get used to, quit/quite/quiet), typical mistakes of Brazilians and, in translations, almost-right translations that change the meaning. Never an absurd option. The right one in a varied position.
- Options never bring two equivalent forms ("won't" and "will not"), unless the form itself is the subject: then the question says which form it wants and the card has "formIsTopic": true.
- Teach the language, never analyse the text as a work: never ask about rhyme, verse, chorus, stanza, meter, the author's intention, literary figures or the structure of the song or poem.
- In "practice", never a question that needs remembering the text.
- Every item has 2 or 3 test cards, and every item is covered by some card.
- Listening cards say real sentences of the language (most from the piece), never Portuguese.
- No card asks a free answer judged by someone: everything is closed or compared with the expected sentence.
`
