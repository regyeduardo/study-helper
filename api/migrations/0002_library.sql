-- Entrega 4 (spec 003, história 2): the library kept in the App. Model approved by the owner on 2026-11-21
-- (data-model.md, "Entrega 4 · modelagem em Go"). Names in English.

-- The map: one row per folder or note in the App or in the Google Drive of a freed account; Local never comes here (FR-057).
CREATE TABLE IF NOT EXISTS library_items (
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('file', 'folder')),
  -- FileType of the note; NULL on a folder
  note_type TEXT,
  name TEXT NOT NULL,
  -- the folder it lives in (folderId of a note, parentId of a folder); NULL at the root
  folder_id TEXT,
  -- the mother note (parentFileId)
  parent_file_id TEXT,
  place TEXT NOT NULL CHECK (place IN ('app', 'drive')),
  place_own INTEGER NOT NULL DEFAULT 0 CHECK (place_own IN (0, 1)),
  -- a Gravação, for the Gravações screen without opening the note
  recording INTEGER NOT NULL DEFAULT 0 CHECK (recording IN (0, 1)),
  position REAL NOT NULL DEFAULT 0,
  -- FileMeta/FolderMeta without sourceExcerpt, pendingExcerpt, source.text, courseMaterial, courseDescription (parts "source", "course")
  meta TEXT NOT NULL DEFAULT '{}',
  -- only the server writes the next four: the current version of each part, the media, and the sizes in the App
  parts TEXT NOT NULL DEFAULT '{}',
  media TEXT,
  note_bytes INTEGER NOT NULL DEFAULT 0,
  media_bytes INTEGER NOT NULL DEFAULT 0,
  drive_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  trashed_at TEXT,
  -- the root of an "Apagar tudo": restoring brings back every row with the same value (FR-017)
  trashed_with TEXT,
  -- deleted for good: a tombstone for 60 days, so the other devices drop it from their cache
  removed_at TEXT,
  -- goes up on each change of the row's own fields; writing a part or the media does not change it (parts have versions of their own)
  rev INTEGER NOT NULL DEFAULT 1,
  -- user.seq of the last change of the row, of a part or of the media
  seq INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS library_items_by_seq ON library_items (user_id, seq);
CREATE INDEX IF NOT EXISTS library_items_by_folder ON library_items (user_id, folder_id);
CREATE INDEX IF NOT EXISTS library_items_by_parent ON library_items (user_id, parent_file_id);
CREATE INDEX IF NOT EXISTS library_items_recordings ON library_items (user_id) WHERE recording = 1;
CREATE INDEX IF NOT EXISTS library_items_by_trash ON library_items (user_id, trashed_with) WHERE trashed_with IS NOT NULL;

-- Where the library index (LibraryIndex without AI keys) is in the storage.
CREATE TABLE IF NOT EXISTS library_index (
  user_id TEXT PRIMARY KEY REFERENCES user (id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

-- An upload in parts that resumes (FR-019): reserved in user.reserved_bytes until completed or abandoned.
CREATE TABLE IF NOT EXISTS uploads (
  -- the uploadId of the storage's multipart upload
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  declared_bytes INTEGER NOT NULL CHECK (declared_bytes > 0),
  -- 10 MiB; only the last part may be smaller
  part_size INTEGER NOT NULL DEFAULT 10485760,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'abandoned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- one open upload per media: a second start gives back the same one, with the parts already received
CREATE UNIQUE INDEX IF NOT EXISTS uploads_one_open ON uploads (user_id, item_id, media_id) WHERE status = 'open';

-- The parts already received, in a table of their own so two parts arriving together do not overwrite each other.
CREATE TABLE IF NOT EXISTS upload_parts (
  upload_id TEXT NOT NULL REFERENCES uploads (id) ON DELETE CASCADE,
  n INTEGER NOT NULL CHECK (n BETWEEN 1 AND 10000),
  etag TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (upload_id, n)
);

-- Objects of the storage nothing points to any more; the cleaning deletes them 31 days later (R6). No foreign key: they outlive a
-- deleted account until then.
CREATE TABLE IF NOT EXISTS orphans (
  object_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('replaced', 'removed', 'abandoned')),
  since TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orphans_by_since ON orphans (since);
