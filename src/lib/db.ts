import Database from "@tauri-apps/plugin-sql";

let db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.load("sqlite:hyji.db");
    await runMigrations(db);
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
  }
}

async function runMigrations(db: Database): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name TEXT NOT NULL,
      parent_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS papers (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      sort_order INTEGER DEFAULT 0,
      title TEXT NOT NULL,
      first_author TEXT DEFAULT '',
      authors TEXT DEFAULT '',
      year INTEGER,
      venue TEXT DEFAULT '',
      link TEXT DEFAULT '',
      raw_bibtex TEXT DEFAULT '',
      status TEXT DEFAULT 'Surveyed' CHECK(status IN ('Surveyed','Fully Reviewed','Revisit Needed')),
      importance TEXT DEFAULT 'Noted' CHECK(importance IN ('Noted','Potentially Relevant','Must-Cite')),
      date_read TEXT DEFAULT (date('now')),
      summary TEXT DEFAULT '',
      differentiation TEXT DEFAULT '',
      questions TEXT DEFAULT '',
      pdf_path TEXT DEFAULT '',
      pdf_storage TEXT DEFAULT 'copy' CHECK(pdf_storage IN ('copy','link')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('highlight','memo')),
      page INTEGER NOT NULL,
      rects_json TEXT DEFAULT '[]',
      selected_text TEXT DEFAULT '',
      color TEXT DEFAULT '#ffd166',
      memo_text TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS note_links (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
      note_field TEXT NOT NULL CHECK(note_field IN ('summary','differentiation','questions')),
      bullet_index INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS keywords (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      keyword TEXT NOT NULL,
      source TEXT DEFAULT 'auto' CHECK(source IN ('auto','manual'))
    );
  `);

  // Indexes
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_papers_project ON papers(project_id);`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_annotations_paper ON annotations(paper_id);`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_keywords_paper ON keywords(paper_id);`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_keywords_keyword ON keywords(keyword);`);

  // Migrations: add columns if missing in existing DBs
  const migrations = [
    `ALTER TABLE papers ADD COLUMN sort_order INTEGER DEFAULT 0`,
    `ALTER TABLE annotations ADD COLUMN rects_json TEXT DEFAULT '[]'`,
    `ALTER TABLE annotations ADD COLUMN memo_text TEXT DEFAULT ''`,
    `ALTER TABLE projects ADD COLUMN folder_path TEXT DEFAULT ''`,
    `ALTER TABLE papers ADD COLUMN link TEXT DEFAULT ''`,
    // Deduplicate keywords then enforce uniqueness to prevent race-condition duplicates
    `DELETE FROM keywords WHERE id NOT IN (SELECT MIN(id) FROM keywords GROUP BY paper_id, keyword)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_keywords_unique ON keywords(paper_id, keyword)`,
  ];
  for (const sql of migrations) {
    try {
      await db.execute(sql);
    } catch {
      // column/index already exists or no-op — safe to ignore
    }
  }
}
