import type { SchemaMigration } from './contract.js';

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
      // Append-only history: no code path issues UPDATE/DELETE on this table,
      // and (commitment_id, revision) is the primary key. A storage-level
      // trigger is not possible here because the runtime admits exactly one SQL
      // statement per migration entry and a trigger body needs an inner `;`.
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
    ],
  },
  {
    owner: 'domain',
    version: 2,
    statements: [
      `CREATE TABLE routing_labels (
         subject_kind TEXT NOT NULL CHECK(subject_kind IN ('session','entry','commitment')),
         subject_id TEXT NOT NULL,
         revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision > 0),
         data_class TEXT NOT NULL CHECK(data_class IN ('ordinary','private','sensitive')),
         writer TEXT NOT NULL CHECK(writer IN ('capture','model','owner_review')),
         recorded_at INTEGER NOT NULL,
         PRIMARY KEY (subject_kind, subject_id, revision),
         CHECK(writer='owner_review' OR
               (writer='capture' AND data_class='private') OR
               (writer='model' AND data_class IN ('private','sensitive')))
       )`,
    ],
  },
  {
    owner: 'domain',
    version: 3,
    statements: [
      // Additive index (R8): leading owner_id serves the existing generic
      // owner-only `sourceReferences` helper, and the trailing owner_kind serves
      // the selected-entry batch resolver's fixed `owner_kind='entry'` predicate.
      `CREATE INDEX ix_source_references_owner ON source_references(owner_id, owner_kind)`,
    ],
  },
];
