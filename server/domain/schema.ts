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
  {
    owner: 'domain',
    version: 4,
    statements: [
      `CREATE TABLE entry_tombstones (
        entry_id TEXT PRIMARY KEY,
        deleted_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason_code TEXT NOT NULL CHECK(reason_code = 'owner_request'),
        source_kind TEXT,
        source_key TEXT
      )`,
      `CREATE INDEX ix_entry_tombstones_source ON entry_tombstones(source_kind, source_key)`,
    ],
  },
  {
    owner: 'domain',
    version: 5,
    statements: [
      `CREATE TABLE conversation_summaries (
        id TEXT PRIMARY KEY,
        live_session_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('complete','skipped','failed')),
        summary TEXT,
        ended_at INTEGER,
        model TEXT,
        input_chars INTEGER,
        input_truncated INTEGER NOT NULL CHECK (input_truncated IN (0,1)),
        injected_summary_ids TEXT NOT NULL,
        retry_count INTEGER NOT NULL,
        error_code TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX ix_conversation_summaries_ended ON conversation_summaries(status, ended_at DESC)`,
    ],
  },
  {
    owner: 'domain',
    version: 6,
    statements: [
      // Summary v2 (3u): a separate open-loop line, the prompt version the row was written under, and the
      // skip reason, so a skipped row says why. All three are nullable: v1 rows read as null, no backfill.
      `ALTER TABLE conversation_summaries ADD COLUMN open_loop TEXT`,
      `ALTER TABLE conversation_summaries ADD COLUMN prompt_version TEXT`,
      `ALTER TABLE conversation_summaries ADD COLUMN skip_reason TEXT`,
    ],
  },
  {
    owner: 'domain', version: 7,
    statements: [
      `CREATE TABLE history_sessions (live_session_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
        data_class TEXT NOT NULL CHECK(data_class IN ('ordinary','private','sensitive')),
        revision INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
      `CREATE TABLE history_exclusions (source_kind TEXT NOT NULL CHECK(source_kind IN ('live','summary')),
        source_id TEXT NOT NULL, forgotten_at INTEGER NOT NULL, PRIMARY KEY(source_kind,source_id))`,
      `CREATE TABLE history_dependencies (child_session_id TEXT NOT NULL, parent_session_id TEXT NOT NULL,
        PRIMARY KEY(child_session_id,parent_session_id))`,
    ],
  },
];
