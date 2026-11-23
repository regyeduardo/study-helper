-- Spec 005 (hierarquia única na conta, data-model.md): the hierarchy lives in the map of every signed-in account. A folder has no
-- place any more (only a note does) and place_own goes away; user.hierarchy_at and hierarchy_backups come in.
-- Runs inside the transaction of store.Migrate: SQLite does not change a CHECK with ALTER, so library_items is rebuilt (new table,
-- copy, drop the old one, rename, indexes back). Rows of before come over whole: folder → place NULL; note keeps its place.

CREATE TABLE library_items_new (
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
  -- where the note's content lives; a folder has no place (FR-005)
  place TEXT,
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
  PRIMARY KEY (user_id, id),
  -- "place IS NOT NULL": a CHECK that gives NULL passes in SQLite, and a note without place must not
  CHECK ((item_kind = 'folder' AND place IS NULL) OR (item_kind = 'file' AND place IS NOT NULL AND place IN ('app', 'drive')))
);

INSERT INTO library_items_new (user_id, id, item_kind, note_type, name, folder_id, parent_file_id, place, recording, position, meta, parts, media,
  note_bytes, media_bytes, drive_ref, created_at, updated_at, trashed_at, trashed_with, removed_at, rev, seq)
SELECT user_id, id, item_kind, note_type, name, folder_id, parent_file_id, CASE WHEN item_kind = 'folder' THEN NULL ELSE place END, recording,
  position, meta, parts, media, note_bytes, media_bytes, drive_ref, created_at, updated_at, trashed_at, trashed_with, removed_at, rev, seq
FROM library_items;

DROP TABLE library_items;
ALTER TABLE library_items_new RENAME TO library_items;

CREATE INDEX library_items_by_seq ON library_items (user_id, seq);
CREATE INDEX library_items_by_folder ON library_items (user_id, folder_id);
CREATE INDEX library_items_by_parent ON library_items (user_id, parent_file_id);
CREATE INDEX library_items_recordings ON library_items (user_id) WHERE recording = 1;
CREATE INDEX library_items_by_trash ON library_items (user_id, trashed_with) WHERE trashed_with IS NOT NULL;

-- when the person's hierarchy was taken to the account (FR-013); NULL = still the way of before
ALTER TABLE user ADD COLUMN hierarchy_at TEXT;

-- The hierarchy of before the migration (FR-014), no note content; kept at least 30 days.
CREATE TABLE hierarchy_backups (
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  -- JSON {folders, files}, without sourceExcerpt, pendingExcerpt, source.text, courseMaterial; up to 4 MiB
  snapshot TEXT NOT NULL,
  -- counts, to check at the end (FR-016)
  folders INTEGER NOT NULL,
  files INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
