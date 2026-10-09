import type { SchemaMigration } from './contract.ts';

// Domain-owned migrations. The runtime applies them in one writer; the domain
// only declares them (SERVICE-CONTRACT: "Domain exports migrations").
export const domainMigrations: SchemaMigration[] = [
  {
    owner: 'domain',
    version: 1,
    statements: [
      `CREATE TABLE sessions (
         id TEXT PRIMARY KEY,
         title TEXT NOT NULL,
         started_at INTEGER NOT NULL,
         ended_at INTEGER,
         time_zone TEXT NOT NULL,
         revision INTEGER NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `CREATE TABLE entries (
         id TEXT PRIMARY KEY,
         session_id TEXT NOT NULL REFERENCES sessions(id),
         sequence INTEGER NOT NULL,
         role TEXT NOT NULL,
         text TEXT NOT NULL,
         captured_at INTEGER NOT NULL,
         time_zone TEXT NOT NULL,
         revision INTEGER NOT NULL,
         UNIQUE (session_id, sequence)
       )`,
      `CREATE TABLE source_references (
         id TEXT PRIMARY KEY,
         owner_kind TEXT NOT NULL,
         owner_id TEXT NOT NULL,
         source_label TEXT NOT NULL,
         provider TEXT,
         account_id TEXT,
         external_id TEXT,
         source_timestamp INTEGER,
         availability TEXT NOT NULL,
         note TEXT
       )`,
      `CREATE TABLE preferences (
         id TEXT PRIMARY KEY,
         key TEXT NOT NULL UNIQUE,
         value TEXT NOT NULL,
         revision INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `CREATE TABLE commitments (
         id TEXT PRIMARY KEY,
         title TEXT NOT NULL,
         notes TEXT NOT NULL,
         due_at INTEGER,
         due_time_zone TEXT,
         status TEXT NOT NULL,
         revision INTEGER NOT NULL,
         source_session_id TEXT,
         source_entry_id TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      // Append-only history, enforced at storage level as well as in code.
      `CREATE TABLE commitment_revisions (
         commitment_id TEXT NOT NULL,
         revision INTEGER NOT NULL,
         title TEXT NOT NULL,
         notes TEXT NOT NULL,
         due_at INTEGER,
         due_time_zone TEXT,
         status TEXT NOT NULL,
         operation TEXT NOT NULL,
         recorded_at INTEGER NOT NULL,
         PRIMARY KEY (commitment_id, revision)
       )`,
      `CREATE TRIGGER commitment_revisions_no_update
         BEFORE UPDATE ON commitment_revisions
         BEGIN SELECT RAISE(ABORT, 'commitment_revisions is append-only'); END`,
      `CREATE TRIGGER commitment_revisions_no_delete
         BEFORE DELETE ON commitment_revisions
         BEGIN SELECT RAISE(ABORT, 'commitment_revisions is append-only'); END`,
    ],
  },
];
