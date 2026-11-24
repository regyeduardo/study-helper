-- Spec 004 (aprender idiomas): the languages mode, exactly as data-model.md approved by the owner on 2026-11-21 ("A").
-- Every row is an account's (ON DELETE CASCADE from user); no AI key in the database. Prefix lang_ to keep it apart from the library.

CREATE TABLE IF NOT EXISTS lang_languages (
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 12),
  name TEXT NOT NULL,
  locale TEXT NOT NULL,
  native TEXT NOT NULL DEFAULT 'pt',
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, code)
);

CREATE TABLE IF NOT EXISTS lang_texts (
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  language TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body TEXT NOT NULL CHECK (length(body) <= 100000),
  source_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('generating', 'ready', 'failed')),
  error TEXT,
  model TEXT,
  created_at TEXT NOT NULL,
  ready_at TEXT,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, language) REFERENCES lang_languages (user_id, code) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS lang_texts_by_language ON lang_texts (user_id, language, created_at);

CREATE TABLE IF NOT EXISTS lang_items (
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  id TEXT NOT NULL,
  area TEXT NOT NULL CHECK (area IN ('lexico', 'gramatica', 'semantica', 'fonologia', 'ortografia', 'registro', 'pragmatica')),
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  meaning TEXT NOT NULL,
  word TEXT,
  pattern TEXT,
  core TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, language, id),
  FOREIGN KEY (user_id, language) REFERENCES lang_languages (user_id, code) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lang_item_needs (
  user_id TEXT NOT NULL,
  language TEXT NOT NULL,
  item_id TEXT NOT NULL,
  needs_id TEXT NOT NULL,
  PRIMARY KEY (user_id, language, item_id, needs_id),
  FOREIGN KEY (user_id, language, item_id) REFERENCES lang_items (user_id, language, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, language, needs_id) REFERENCES lang_items (user_id, language, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lang_equivalences (
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  grp INTEGER NOT NULL,
  form TEXT NOT NULL,
  PRIMARY KEY (user_id, language, form)
);

CREATE TABLE IF NOT EXISTS lang_text_items (
  user_id TEXT NOT NULL,
  text_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (user_id, text_id, item_id),
  FOREIGN KEY (user_id, text_id) REFERENCES lang_texts (user_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lang_cards (
  user_id TEXT NOT NULL,
  text_id TEXT NOT NULL,
  id TEXT NOT NULL,
  part TEXT NOT NULL CHECK (part IN ('test', 'practice', 'context')),
  item_id TEXT,
  position INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('mc', 'tf', 'gap', 'order', 'match', 'odd', 'listen_mc', 'minimal_pair', 'same_diff', 'find_diff', 'stress', 'dictation', 'dictation_gap', 'speak')),
  skill TEXT NOT NULL CHECK (skill IN ('read', 'listen', 'speak')),
  data TEXT NOT NULL,
  PRIMARY KEY (user_id, text_id, id),
  FOREIGN KEY (user_id, text_id) REFERENCES lang_texts (user_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lang_card_items (
  user_id TEXT NOT NULL,
  text_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('covers', 'needs')),
  PRIMARY KEY (user_id, text_id, card_id, item_id, role),
  FOREIGN KEY (user_id, text_id, card_id) REFERENCES lang_cards (user_id, text_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lang_knowledge (
  user_id TEXT NOT NULL,
  language TEXT NOT NULL,
  item_id TEXT NOT NULL,
  skill TEXT NOT NULL CHECK (skill IN ('recognize', 'produce', 'listen', 'speak')),
  status TEXT NOT NULL CHECK (status IN ('learning', 'fixed')),
  interval_days INTEGER NOT NULL CHECK (interval_days IN (0, 1, 3, 7, 21, 45, 90, 180)),
  streak INTEGER NOT NULL DEFAULT 0,
  due_at TEXT,
  last_ok INTEGER CHECK (last_ok IN (0, 1)),
  last_at TEXT,
  PRIMARY KEY (user_id, language, item_id, skill),
  FOREIGN KEY (user_id, language, item_id) REFERENCES lang_items (user_id, language, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS lang_knowledge_due ON lang_knowledge (user_id, language, due_at);

CREATE TABLE IF NOT EXISTS lang_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  text_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('test', 'practice', 'context')),
  prompt_lang TEXT NOT NULL CHECK (prompt_lang IN ('native', 'target')),
  answer TEXT,
  ok INTEGER CHECK (ok IN (0, 1)),
  retry INTEGER NOT NULL DEFAULT 0 CHECK (retry IN (0, 1)),
  recording_key TEXT,
  proofs TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lang_answers_by_text ON lang_answers (user_id, text_id, created_at);

CREATE TABLE IF NOT EXISTS lang_progress (
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  text_id TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, text_id)
);
