-- Spec 004, 24/11 (data-model.md › Mudança de 24/11, approved by the owner: "Aprovo"): "É por card. Cards podem ser aproveitados
-- se tiver o mesmo significado e/ou mesmo contexto". Cards go from the text to the language and serve many texts (lang_text_cards
-- says which, in what part and order); each card has its FSRS schedule (the app computes it, the server keeps it); lang_knowledge
-- goes (an item's state comes from its cards); answers gain the language and the FSRS rating. Deleting a text keeps the base.

CREATE TABLE lang_cards_v2 (
  user_id TEXT NOT NULL,
  language TEXT NOT NULL,
  id TEXT NOT NULL,
  item_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('mc', 'tf', 'gap', 'order', 'match', 'odd', 'listen_mc', 'minimal_pair', 'same_diff', 'find_diff', 'stress', 'dictation', 'dictation_gap', 'speak')),
  skill TEXT NOT NULL CHECK (skill IN ('read', 'listen', 'speak')),
  reuse_key TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, language, id),
  FOREIGN KEY (user_id, language) REFERENCES lang_languages (user_id, code) ON DELETE CASCADE
);

CREATE TABLE lang_text_cards (
  user_id TEXT NOT NULL,
  text_id TEXT NOT NULL,
  language TEXT NOT NULL,
  card_id TEXT NOT NULL,
  part TEXT NOT NULL CHECK (part IN ('test', 'practice', 'context')),
  position INTEGER NOT NULL,
  PRIMARY KEY (user_id, text_id, card_id),
  FOREIGN KEY (user_id, text_id) REFERENCES lang_texts (user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, language, card_id) REFERENCES lang_cards_v2 (user_id, language, id) ON DELETE CASCADE
);

CREATE TABLE lang_card_items_v2 (
  user_id TEXT NOT NULL,
  language TEXT NOT NULL,
  card_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('covers', 'needs')),
  PRIMARY KEY (user_id, language, card_id, item_id, role),
  FOREIGN KEY (user_id, language, card_id) REFERENCES lang_cards_v2 (user_id, language, id) ON DELETE CASCADE
);

CREATE TABLE lang_card_schedule (
  user_id TEXT NOT NULL,
  language TEXT NOT NULL,
  card_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('new', 'learning', 'review', 'relearning')),
  step INTEGER NOT NULL DEFAULT 0,
  stability REAL,
  difficulty REAL,
  due_at TEXT,
  last_review_at TEXT,
  scheduled_days INTEGER NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, language, card_id),
  FOREIGN KEY (user_id, language, card_id) REFERENCES lang_cards_v2 (user_id, language, id) ON DELETE CASCADE
);

-- Each old card's id in the language: a test card of an item keeps it (the same card in every text: one card); any other card
-- keeps it too, unless an older text of the language already has that id: then the text's id goes in front.
CREATE TEMP TABLE lang_card_ids AS
SELECT c.user_id, c.text_id, t.language, c.id AS old_id,
  CASE WHEN c.part = 'test' OR ROW_NUMBER() OVER (PARTITION BY c.user_id, t.language, c.id ORDER BY t.created_at, c.text_id) = 1
    THEN c.id ELSE c.text_id || '.' || c.id END AS new_id
FROM lang_cards c JOIN lang_texts t ON t.user_id = c.user_id AND t.id = c.text_id;

INSERT OR IGNORE INTO lang_cards_v2 (user_id, language, id, item_id, type, skill, reuse_key, data, created_at)
SELECT c.user_id, m.language, m.new_id, c.item_id, c.type, c.skill, NULL,
  CASE WHEN m.new_id = c.id THEN c.data ELSE json_set(c.data, '$.id', m.new_id) END,
  COALESCE(t.ready_at, t.created_at)
FROM lang_cards c
JOIN lang_card_ids m ON m.user_id = c.user_id AND m.text_id = c.text_id AND m.old_id = c.id
JOIN lang_texts t ON t.user_id = c.user_id AND t.id = c.text_id
ORDER BY t.created_at, c.text_id, c.position;

INSERT OR IGNORE INTO lang_text_cards (user_id, text_id, language, card_id, part, position)
SELECT c.user_id, c.text_id, m.language, m.new_id, c.part, c.position
FROM lang_cards c JOIN lang_card_ids m ON m.user_id = c.user_id AND m.text_id = c.text_id AND m.old_id = c.id;

INSERT OR IGNORE INTO lang_card_items_v2 (user_id, language, card_id, item_id, role)
SELECT ci.user_id, m.language, m.new_id, ci.item_id, ci.role
FROM lang_card_items ci JOIN lang_card_ids m ON m.user_id = ci.user_id AND m.text_id = ci.text_id AND m.old_id = ci.card_id;

ALTER TABLE lang_answers ADD COLUMN language TEXT NOT NULL DEFAULT '';
ALTER TABLE lang_answers ADD COLUMN rating INTEGER CHECK (rating IN (1, 2, 3));
UPDATE lang_answers SET
  language = COALESCE((SELECT t.language FROM lang_texts t WHERE t.user_id = lang_answers.user_id AND t.id = lang_answers.text_id), ''),
  card_id = COALESCE((SELECT m.new_id FROM lang_card_ids m WHERE m.user_id = lang_answers.user_id AND m.text_id = lang_answers.text_id AND m.old_id = lang_answers.card_id), card_id),
  rating = CASE WHEN ok IS NULL THEN NULL WHEN ok = 0 THEN 1 WHEN retry = 1 THEN 2 ELSE 3 END;

DROP TABLE lang_card_ids;
DROP TABLE lang_card_items;
DROP TABLE lang_cards;
DROP TABLE lang_knowledge;
ALTER TABLE lang_cards_v2 RENAME TO lang_cards;
ALTER TABLE lang_card_items_v2 RENAME TO lang_card_items;

CREATE UNIQUE INDEX lang_cards_reuse ON lang_cards (user_id, language, reuse_key) WHERE reuse_key IS NOT NULL;
CREATE INDEX lang_cards_by_item ON lang_cards (user_id, language, item_id);
CREATE INDEX lang_text_cards_by_card ON lang_text_cards (user_id, language, card_id);
CREATE INDEX lang_card_schedule_due ON lang_card_schedule (user_id, language, due_at);
CREATE INDEX lang_answers_by_card ON lang_answers (user_id, language, card_id, created_at);
