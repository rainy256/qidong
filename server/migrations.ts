import type Database from 'better-sqlite3';

interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '001_initial_schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS rooms (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          game_tag TEXT,
          owner_token_hash TEXT NOT NULL,
          tzid TEXT NOT NULL DEFAULT 'Asia/Shanghai',
          nights_json TEXT NOT NULL,
          target_players INTEGER NOT NULL,
          duration_slots INTEGER NOT NULL,
          room_revision INTEGER NOT NULL DEFAULT 1,
          closed_at TEXT,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS participants (
          room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          member_token_hash TEXT NOT NULL,
          nickname TEXT NOT NULL,
          answer_kind TEXT NOT NULL CHECK (answer_kind IN ('available', 'unavailable')),
          picks_json TEXT NOT NULL,
          participant_rev INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (room_id, id),
          UNIQUE (room_id, member_token_hash)
        );

        CREATE INDEX IF NOT EXISTS idx_participants_room ON participants(room_id);

        CREATE TABLE IF NOT EXISTS mutations (
          scope TEXT NOT NULL,
          mutation_id TEXT NOT NULL,
          room_revision INTEGER NOT NULL,
          room_id TEXT,
          request_hash TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (scope, mutation_id)
        );

        CREATE INDEX IF NOT EXISTS idx_rooms_expires ON rooms(expires_at);
        CREATE INDEX IF NOT EXISTS idx_mutations_created ON mutations(created_at);
      `);
    },
  },
  {
    version: 2,
    name: '002_ensure_mutation_columns',
    up: (db) => {
      const cols = db.pragma('table_info(mutations)') as Array<{ name: string }>;
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has('room_id')) {
        db.exec('ALTER TABLE mutations ADD COLUMN room_id TEXT');
      }
      if (!colNames.has('request_hash')) {
        db.exec('ALTER TABLE mutations ADD COLUMN request_hash TEXT');
      }
    },
  },
];

export function runMigrations(db: Database.Database): void {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedRows = db
      .prepare('SELECT version FROM schema_migrations')
      .all() as Array<{ version: number }>;
    const applied = new Set(appliedRows.map((r) => r.version));

    const insertMigration = db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      migration.up(db);
      insertMigration.run(migration.version, migration.name, new Date().toISOString());
    }
  });

  tx.immediate();
}
