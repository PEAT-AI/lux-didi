import type { SchemaMigration } from '../contracts/storage.js';
export const toolsMigrations: readonly SchemaMigration[] = [{ owner: 'tools', version: 1, statements: [
  `CREATE TABLE tool_connections (
    owner_id TEXT NOT NULL, connection_id TEXT NOT NULL, endpoint_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation>0), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    policy_json TEXT NOT NULL, policy_sha256 TEXT NOT NULL,
    PRIMARY KEY(owner_id,connection_id), UNIQUE(owner_id,endpoint_id))`,
  `CREATE TABLE tool_runs (
    owner_id TEXT NOT NULL, run_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL,
    PRIMARY KEY(owner_id,run_id))`,
  `CREATE TABLE tool_calls (
    owner_id TEXT NOT NULL, run_id TEXT NOT NULL, execution_id TEXT NOT NULL, call_id TEXT,
    intent_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('intent','completed','failed','unknown','refused')),
    result_id TEXT UNIQUE, result_json TEXT, result_sha256 TEXT,
    PRIMARY KEY(owner_id,run_id,execution_id), UNIQUE(owner_id,run_id,call_id),
    CHECK((state='intent' AND result_id IS NULL AND result_json IS NULL AND result_sha256 IS NULL) OR
      (state!='intent' AND result_id IS NOT NULL AND result_json IS NOT NULL AND result_sha256 IS NOT NULL)))`,
  `CREATE TRIGGER tool_connections_no_replace BEFORE INSERT ON tool_connections
    WHEN EXISTS(SELECT 1 FROM tool_connections WHERE owner_id=NEW.owner_id AND (connection_id=NEW.connection_id OR endpoint_id=NEW.endpoint_id))
    BEGIN SELECT RAISE(ABORT,'connection_replace_forbidden'); END`,
  `CREATE TRIGGER tool_connections_no_delete BEFORE DELETE ON tool_connections BEGIN SELECT RAISE(ABORT,'connection_delete_forbidden'); END`,
  `CREATE TRIGGER tool_connections_update_guard BEFORE UPDATE ON tool_connections
    WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.connection_id IS NOT OLD.connection_id OR NEW.endpoint_id IS NOT OLD.endpoint_id OR NEW.generation<=OLD.generation
    BEGIN SELECT RAISE(ABORT,'connection_identity_or_generation'); END`,
  `CREATE TRIGGER tool_runs_no_replace BEFORE INSERT ON tool_runs
    WHEN EXISTS(SELECT 1 FROM tool_runs WHERE owner_id=NEW.owner_id AND run_id=NEW.run_id)
    BEGIN SELECT RAISE(ABORT,'run_replace_forbidden'); END`,
  `CREATE TRIGGER tool_runs_no_delete BEFORE DELETE ON tool_runs BEGIN SELECT RAISE(ABORT,'run_delete_forbidden'); END`,
  `CREATE TRIGGER tool_runs_no_update BEFORE UPDATE ON tool_runs BEGIN SELECT RAISE(ABORT,'run_update_forbidden'); END`,
  `CREATE TRIGGER tool_calls_no_replace BEFORE INSERT ON tool_calls
    WHEN EXISTS(SELECT 1 FROM tool_calls WHERE (owner_id=NEW.owner_id AND run_id=NEW.run_id AND (execution_id=NEW.execution_id OR (NEW.call_id IS NOT NULL AND call_id=NEW.call_id))) OR (NEW.result_id IS NOT NULL AND result_id=NEW.result_id))
    BEGIN SELECT RAISE(ABORT,'call_replace_forbidden'); END`,
  `CREATE TRIGGER tool_calls_no_delete BEFORE DELETE ON tool_calls BEGIN SELECT RAISE(ABORT,'call_delete_forbidden'); END`,
  `CREATE TRIGGER tool_calls_update_guard BEFORE UPDATE ON tool_calls
    WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.run_id IS NOT OLD.run_id OR NEW.execution_id IS NOT OLD.execution_id OR NEW.call_id IS NOT OLD.call_id OR NEW.intent_json IS NOT OLD.intent_json OR OLD.state!='intent' OR NEW.state='intent'
    BEGIN SELECT RAISE(ABORT,'call_identity_or_terminal'); END`,
] }];
