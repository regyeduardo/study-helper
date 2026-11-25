-- spec 007, história 2 (research R10b, data-model.md): the jobs of generating in the account. A job is a call of the app's generations
-- store, run by the app itself in a headless Chromium on the server; `request` keeps the call and its arguments, `result` the value it
-- gave back. Taken a copy of the database before applying (FR-070).

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  -- the method of the generations store (generateFromNote, generateAta…), and what it makes, for the history of times
  call TEXT NOT NULL,
  kind TEXT NOT NULL,
  -- the note it starts from, when there is one
  file_id TEXT,
  title TEXT NOT NULL,
  -- JSON {"call": "...", "args": [...]}
  request TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'cancelled', 'dismissed')),
  -- the step in the person's words, and how much of it is done (0 to 1), as the page reports it
  stage TEXT,
  fraction REAL,
  eta_at TEXT,
  eta_basis TEXT CHECK (eta_basis IN ('parts', 'history')),
  last_progress_at TEXT,
  last_progress TEXT,
  stalled_since TEXT,
  -- JSON: the value the call gave back
  result TEXT,
  error TEXT,
  error_code TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  -- the ticket of one use the Chromium enters with, and the device (session) of the job page
  ticket_hash TEXT,
  ticket_expires_at TEXT,
  device_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_by_user_state ON jobs (user_id, state);
CREATE INDEX IF NOT EXISTS jobs_by_state ON jobs (state, created_at);
CREATE INDEX IF NOT EXISTS jobs_by_kind ON jobs (user_id, kind, finished_at);
