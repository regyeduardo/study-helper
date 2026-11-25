-- spec 007, FR-055 (003 FR-048): the use of the app's AI by each account, per day, for the owner to follow the cost in the
-- Administração. `calls` counts the answers the providers gave through the server; the tokens are the provider's own count in its
-- answer (0 when it does not say). Taken a copy of the database before applying (FR-070).

CREATE TABLE IF NOT EXISTS ai_usage (
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  -- YYYY-MM-DD, in UTC
  day TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
) WITHOUT ROWID;
