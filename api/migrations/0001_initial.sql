-- Initial SQLite schema of the Go service (spec 003, data-model.md): account, Google and password sign-in, promo codes, settings, devices and shared links.
-- Names in English, as the owner decided on 2026-11-20. The library map, uploads and jobs come with deliveries 4 and 5.

CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  -- the Google account, when the person signs in with Google (empty for e-mail and password only)
  google_sub TEXT UNIQUE,
  google_permission_id TEXT,
  -- the e-mail is also the user name of the e-mail and password sign-in
  email TEXT UNIQUE NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  -- argon2id; empty for Google only
  password_hash TEXT,
  -- wrong passwords in a row; the 10th blocks the sign-in for 15 minutes
  login_failures INTEGER NOT NULL DEFAULT 0,
  login_blocked_until TEXT,
  name TEXT,
  photo_url TEXT,
  status TEXT NOT NULL DEFAULT 'no-code' CHECK (status IN ('no-code', 'enabled', 'revoked')),
  -- "Usar a estrutura do app"
  app_enabled INTEGER NOT NULL DEFAULT 0 CHECK (app_enabled IN (0, 1)),
  enabled_at TEXT,
  revoked_at TEXT,
  -- revoked_at + 30 days
  delete_at TEXT,
  -- counts the changes of the library (R10)
  seq INTEGER NOT NULL DEFAULT 0,
  notes_bytes INTEGER NOT NULL DEFAULT 0,
  media_bytes INTEGER NOT NULL DEFAULT 0,
  reserved_bytes INTEGER NOT NULL DEFAULT 0,
  usage_checked_at TEXT,
  usage_diff INTEGER,
  -- wrong promo codes in a row; the 10th blocks for 1 hour
  code_failures INTEGER NOT NULL DEFAULT 0,
  code_blocked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_google (
  user_id TEXT PRIMARY KEY REFERENCES user (id) ON DELETE CASCADE,
  -- Google refresh token, AES-GCM with the TOKEN_CHAVE secret
  refresh_token_encrypted TEXT NOT NULL,
  scopes TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id TEXT PRIMARY KEY,
  -- normalized: upper case, no spaces nor dashes
  code TEXT UNIQUE NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  uses INTEGER NOT NULL DEFAULT 0,
  valid_until TEXT NOT NULL,
  made_for TEXT,
  -- canceling only stops new uses
  canceled_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS promo_code_uses (
  -- an account uses a code only once
  user_id TEXT PRIMARY KEY REFERENCES user (id) ON DELETE CASCADE,
  promo_code_id TEXT NOT NULL REFERENCES promo_codes (id),
  used_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS promo_code_uses_by_code ON promo_code_uses (promo_code_id);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- while the service is closed to the public, turning the app structure on asks for a promo code (FR-002, FR-007)
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('require_code', '1');

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  -- SHA-256 of the estudo_sessao cookie, never the cookie itself
  session_hash TEXT UNIQUE NOT NULL,
  -- "Chrome no Linux"; the person can rename it
  name TEXT,
  created_at TEXT NOT NULL,
  -- updated at most once a day
  seen_at TEXT NOT NULL,
  -- seen_at + 180 days
  expires_at TEXT NOT NULL,
  signed_out_at TEXT
);
CREATE INDEX IF NOT EXISTS devices_by_user ON devices (user_id);

-- Links the person made (FR-034 to FR-037, FR-061 to FR-063). A link of an item kept in the App is live and never expires
-- (expires_at NULL); a copy (media in the Google Drive or in Local) expires.
CREATE TABLE IF NOT EXISTS shared_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('file', 'folder')),
  title TEXT NOT NULL,
  -- 1: live from the App; 0: a copy, with expires_at
  live INTEGER NOT NULL DEFAULT 1 CHECK (live IN (0, 1)),
  with_exams INTEGER NOT NULL DEFAULT 0 CHECK (with_exams IN (0, 1)),
  -- the chosen artifacts, JSON: ["mapa", "cartoes", "tutor"]
  artifacts TEXT NOT NULL DEFAULT '[]',
  bytes INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  -- "Parar de compartilhar"
  stopped_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shared_links_by_item ON shared_links (user_id, item_id);

-- Links the person received and opened or imported ("Compartilhado comigo"). The link may belong to anyone, or to the old
-- share service, so no foreign key to shared_links.
CREATE TABLE IF NOT EXISTS shared_links_used (
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  shared_link_id TEXT NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('file', 'folder')),
  title TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  -- the copy made in the library, when imported
  imported_at TEXT,
  imported_item_id TEXT,
  expires_at TEXT,
  PRIMARY KEY (user_id, shared_link_id)
);
