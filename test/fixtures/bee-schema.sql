-- The personal database's schema (bee-database, as of 2026-11-24), for tests of bee/ and the live build.
CREATE TABLE records (
    n          INTEGER PRIMARY KEY,
    id         TEXT UNIQUE NOT NULL,
    project    TEXT NOT NULL,
    collection TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL,
    tags       TEXT NOT NULL DEFAULT '[]',
    metadata   TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX records_pc ON records(project, collection, updated_at);
CREATE INDEX records_updated ON records(updated_at);
CREATE VIRTUAL TABLE records_fts USING fts5(
    title, content, tags, project UNINDEXED, collection UNINDEXED,
    content='records', content_rowid='n', tokenize='porter unicode61'
);
CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN
    INSERT INTO records_fts(rowid, title, content, tags, project, collection)
    VALUES (new.n, new.title, new.content, new.tags, new.project, new.collection);
END;
CREATE TRIGGER records_ad AFTER DELETE ON records BEGIN
    INSERT INTO records_fts(records_fts, rowid, title, content, tags, project, collection)
    VALUES ('delete', old.n, old.title, old.content, old.tags, old.project, old.collection);
END;
CREATE TRIGGER records_au AFTER UPDATE ON records BEGIN
    INSERT INTO records_fts(records_fts, rowid, title, content, tags, project, collection)
    VALUES ('delete', old.n, old.title, old.content, old.tags, old.project, old.collection);
    INSERT INTO records_fts(rowid, title, content, tags, project, collection)
    VALUES (new.n, new.title, new.content, new.tags, new.project, new.collection);
END;
