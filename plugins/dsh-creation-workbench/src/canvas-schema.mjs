import path from 'node:path';
import { lstatSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Keep legacy SQL and stable requirement_id values while making the actual owner a canvas.
export function initializeCanvasSchema(db, metadata) {
  const legacy = db.prepare("SELECT type FROM sqlite_master WHERE name='requirements'").get();
  if (legacy?.type === 'table') {
    const directory = path.join(metadata, 'migrations');
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error('迁移备份目录不可用');
    const backup = path.join(directory, `cw45-before-${randomUUID()}.sqlite`);
    // VACUUM INTO includes committed WAL pages; never copy a live database file alone.
    db.prepare('VACUUM INTO ?').run(backup);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // Recheck after obtaining the write lock, so two processes cannot rename twice.
    if (db.prepare("SELECT type FROM sqlite_master WHERE name='requirements'").get()?.type === 'table') {
      db.exec('ALTER TABLE requirements RENAME TO canvas_spaces');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS canvas_spaces (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, customer TEXT NOT NULL,
        audience TEXT NOT NULL, background TEXT NOT NULL, objectives TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canvas_metadata (
        canvas_id TEXT PRIMARY KEY REFERENCES canvas_spaces(id), origin TEXT NOT NULL
      );
      INSERT OR IGNORE INTO canvas_metadata SELECT id,'legacy-requirement' FROM canvas_spaces;
      CREATE VIEW IF NOT EXISTS requirements AS SELECT * FROM canvas_spaces;
      CREATE TRIGGER IF NOT EXISTS requirements_insert INSTEAD OF INSERT ON requirements BEGIN
        INSERT INTO canvas_spaces VALUES (NEW.id,NEW.title,NEW.customer,NEW.audience,NEW.background,NEW.objectives,NEW.created_at,NEW.updated_at);
        INSERT INTO canvas_metadata VALUES (NEW.id,'legacy-requirement');
      END;
      CREATE TRIGGER IF NOT EXISTS requirements_update INSTEAD OF UPDATE ON requirements BEGIN
        UPDATE canvas_spaces SET title=NEW.title,customer=NEW.customer,audience=NEW.audience,
          background=NEW.background,objectives=NEW.objectives,created_at=NEW.created_at,updated_at=NEW.updated_at WHERE id=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS requirements_delete INSTEAD OF DELETE ON requirements BEGIN
        DELETE FROM canvas_metadata WHERE canvas_id=OLD.id;
        DELETE FROM canvas_spaces WHERE id=OLD.id;
      END;
    `);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
