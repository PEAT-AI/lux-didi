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
] }, { owner: 'tools', version: 2, statements: [
  `CREATE TABLE tool_connection_semantics (owner_id TEXT NOT NULL, connection_id TEXT NOT NULL, binding_mode TEXT NOT NULL CHECK(binding_mode='connection'), PRIMARY KEY(owner_id,connection_id), FOREIGN KEY(owner_id,connection_id) REFERENCES tool_connections(owner_id,connection_id))`,
  `CREATE TRIGGER tool_connection_semantics_no_update BEFORE UPDATE ON tool_connection_semantics BEGIN SELECT RAISE(ABORT,'connection_semantics_immutable'); END`,
  `CREATE TRIGGER tool_connection_semantics_no_delete BEFORE DELETE ON tool_connection_semantics BEGIN SELECT RAISE(ABORT,'connection_semantics_immutable'); END`,
] }, { owner: 'tools', version: 3, statements: [
  `ALTER TABLE tool_calls ADD COLUMN input_json TEXT`,
  `ALTER TABLE tool_calls ADD COLUMN input_sha256 TEXT`,
  `ALTER TABLE tool_calls ADD COLUMN input_fidelity TEXT`,
  `ALTER TABLE tool_calls ADD COLUMN input_key_count INTEGER`,
  `CREATE TRIGGER tool_calls_input_count_guard BEFORE INSERT ON tool_calls WHEN NEW.input_key_count IS NOT NULL AND (typeof(NEW.input_key_count)!='integer' OR NEW.input_key_count<0) BEGIN SELECT RAISE(ABORT,'input_count_invalid'); END`,
  `CREATE TABLE tool_dispatches (
    dispatch_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, run_id TEXT NOT NULL, execution_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal>0), connector TEXT NOT NULL, connection_id TEXT NOT NULL, policy_sha256 TEXT NOT NULL,run_snapshot_sha256 TEXT NOT NULL,
    binding_digest TEXT NOT NULL,schema_digest TEXT NOT NULL,source_policy_id TEXT NOT NULL,source_policy_revision INTEGER NOT NULL,account_id TEXT NOT NULL,resource_id TEXT NOT NULL,
    session_revision INTEGER, session_class TEXT, source_class TEXT NOT NULL CHECK(source_class IN ('ordinary','private','sensitive')), authority_epoch TEXT NOT NULL,
    endpoint_id TEXT NOT NULL, tool_name TEXT NOT NULL, generation INTEGER NOT NULL,
    arguments_json TEXT, arguments_sha256 TEXT NOT NULL, arguments_fidelity TEXT NOT NULL,arguments_key_count INTEGER CHECK(arguments_key_count>=0),
    started_at INTEGER NOT NULL, started_mono_ms INTEGER NOT NULL, clock_domain TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','completed','unavailable','unknown')),
    completed_at INTEGER, completed_mono_ms INTEGER, completed_clock_domain TEXT, reason TEXT, source_outcome TEXT CHECK(source_outcome IN ('completed','tool-error','protocol-error','refused','unknown')), wire_state TEXT CHECK(wire_state IN ('observed','not_dispatched','unknown')), wire_at INTEGER, wire_mono_ms INTEGER,wire_clock_domain TEXT,
    entity_sha256 TEXT, entity_bytes INTEGER, source_json TEXT, source_sha256 TEXT, source_bytes INTEGER,
    UNIQUE(owner_id,run_id,execution_id,ordinal),
    FOREIGN KEY(owner_id,run_id,execution_id) REFERENCES tool_calls(owner_id,run_id,execution_id),
    CHECK((state='pending' AND source_outcome IS NULL AND wire_state IS NULL AND wire_at IS NULL AND wire_mono_ms IS NULL AND wire_clock_domain IS NULL AND completed_clock_domain IS NULL AND completed_at IS NULL AND completed_mono_ms IS NULL AND reason IS NULL AND source_json IS NULL AND source_sha256 IS NULL AND source_bytes IS NULL AND entity_sha256 IS NULL AND entity_bytes IS NULL) OR
      (state!='pending' AND completed_at IS NOT NULL AND completed_mono_ms IS NOT NULL AND reason IS NOT NULL)),
    CHECK((state='completed' AND source_json IS NOT NULL AND source_sha256 IS NOT NULL AND source_bytes>0 AND entity_sha256 IS NOT NULL AND entity_bytes>0) OR
      (state!='completed' AND source_json IS NULL AND source_sha256 IS NULL AND source_bytes IS NULL)))`,
  `CREATE TRIGGER tool_dispatches_active_parent BEFORE INSERT ON tool_dispatches WHEN NOT EXISTS(SELECT 1 FROM tool_calls WHERE owner_id=NEW.owner_id AND run_id=NEW.run_id AND execution_id=NEW.execution_id AND state='intent') BEGIN SELECT RAISE(ABORT,'dispatch_parent_not_active'); END`,
  `CREATE TRIGGER tool_dispatches_no_replace BEFORE INSERT ON tool_dispatches WHEN EXISTS(SELECT 1 FROM tool_dispatches WHERE dispatch_id=NEW.dispatch_id OR (owner_id=NEW.owner_id AND run_id=NEW.run_id AND execution_id=NEW.execution_id AND ordinal=NEW.ordinal)) BEGIN SELECT RAISE(ABORT,'dispatch_replace_forbidden'); END`,
  `CREATE TRIGGER tool_dispatches_seal_guard BEFORE UPDATE ON tool_dispatches WHEN OLD.state!='pending' OR NEW.state='pending' OR NEW.dispatch_id IS NOT OLD.dispatch_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.run_id IS NOT OLD.run_id OR NEW.execution_id IS NOT OLD.execution_id OR NEW.ordinal IS NOT OLD.ordinal OR NEW.connector IS NOT OLD.connector OR NEW.connection_id IS NOT OLD.connection_id OR NEW.policy_sha256 IS NOT OLD.policy_sha256 OR NEW.run_snapshot_sha256 IS NOT OLD.run_snapshot_sha256 OR NEW.binding_digest IS NOT OLD.binding_digest OR NEW.schema_digest IS NOT OLD.schema_digest OR NEW.source_policy_id IS NOT OLD.source_policy_id OR NEW.source_policy_revision IS NOT OLD.source_policy_revision OR NEW.account_id IS NOT OLD.account_id OR NEW.resource_id IS NOT OLD.resource_id OR NEW.session_revision IS NOT OLD.session_revision OR NEW.session_class IS NOT OLD.session_class OR NEW.source_class IS NOT OLD.source_class OR NEW.authority_epoch IS NOT OLD.authority_epoch OR NEW.endpoint_id IS NOT OLD.endpoint_id OR NEW.tool_name IS NOT OLD.tool_name OR NEW.generation IS NOT OLD.generation OR NEW.arguments_json IS NOT OLD.arguments_json OR NEW.arguments_sha256 IS NOT OLD.arguments_sha256 OR NEW.arguments_fidelity IS NOT OLD.arguments_fidelity OR NEW.arguments_key_count IS NOT OLD.arguments_key_count OR NEW.started_at IS NOT OLD.started_at OR NEW.started_mono_ms IS NOT OLD.started_mono_ms OR NEW.clock_domain IS NOT OLD.clock_domain BEGIN SELECT RAISE(ABORT,'dispatch_identity_or_terminal'); END`,
  `CREATE TRIGGER tool_dispatches_no_delete BEFORE DELETE ON tool_dispatches BEGIN SELECT RAISE(ABORT,'dispatch_delete_forbidden'); END`,
  `CREATE TABLE tool_dispatch_coverage (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,run_id TEXT,execution_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('pre_wire_rejected','wire_record_failed','seal_write_failed','unattributed')),reason TEXT NOT NULL,observed_at INTEGER NOT NULL)`,
  `CREATE TABLE tool_dispatch_reuse (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,run_id TEXT NOT NULL,execution_id TEXT NOT NULL,origin_dispatch_id TEXT REFERENCES tool_dispatches(dispatch_id),observed_at INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('referenced','unavailable')),reason TEXT NOT NULL,CHECK((state='referenced' AND origin_dispatch_id IS NOT NULL) OR (state='unavailable' AND origin_dispatch_id IS NULL)))`,
  `CREATE TRIGGER tool_dispatch_reuse_active_parent BEFORE INSERT ON tool_dispatch_reuse WHEN NOT EXISTS(SELECT 1 FROM tool_calls WHERE owner_id=NEW.owner_id AND run_id=NEW.run_id AND execution_id=NEW.execution_id AND state='intent') BEGIN SELECT RAISE(ABORT,'reuse_parent_not_active'); END`,
  `CREATE TRIGGER tool_dispatch_reuse_no_update BEFORE UPDATE ON tool_dispatch_reuse BEGIN SELECT RAISE(ABORT,'reuse_immutable'); END`,
  `CREATE TRIGGER tool_dispatch_reuse_no_delete BEFORE DELETE ON tool_dispatch_reuse BEGIN SELECT RAISE(ABORT,'reuse_delete_forbidden'); END`,
  `DROP TRIGGER tool_calls_update_guard`,
  `CREATE TRIGGER tool_calls_update_guard BEFORE UPDATE ON tool_calls WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.run_id IS NOT OLD.run_id OR NEW.execution_id IS NOT OLD.execution_id OR NEW.call_id IS NOT OLD.call_id OR NEW.intent_json IS NOT OLD.intent_json OR NEW.input_json IS NOT OLD.input_json OR NEW.input_sha256 IS NOT OLD.input_sha256 OR NEW.input_fidelity IS NOT OLD.input_fidelity OR NEW.input_key_count IS NOT OLD.input_key_count OR OLD.state!='intent' OR NEW.state='intent' BEGIN SELECT RAISE(ABORT,'call_identity_or_terminal'); END`,
] }];
