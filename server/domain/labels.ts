import { badRequest, conflict } from './contract.js';
import type { DomainOperation, RoutingDataClass, RoutingLabel, RoutingLabelCorrection, RoutingLabelLookup, RoutingSubject, SQLRow, Transaction, TrustedWriteLabel } from './contract.js';
import { readSession, readEntry } from './memory.js';
import { readCommitment } from './commitments.js';

// Validate trusted composition before execute can mutate any subject or outbox.
export function validateWriteLabel(operation: DomainOperation, label: TrustedWriteLabel | undefined): void {
  if (label === undefined) return;
  if (!['createSession', 'appendEntry', 'appendAssistantEntry', 'createCommitment'].includes(operation)) {
    badRequest(`routing label unsupported for ${operation}`);
  }
  if (!label || typeof label !== 'object' ||
      !((label.writer === 'capture' && label.dataClass === 'private') ||
        (label.writer === 'model' && (label.dataClass === 'private' || label.dataClass === 'sensitive')))) {
    badRequest('invalid trusted routing label');
  }
  if ((operation === 'appendEntry' && label.writer !== 'capture') ||
      (operation === 'appendAssistantEntry' && label.writer !== 'model')) {
    badRequest(`inconsistent routing writer for ${operation}`);
  }
}

function existingSubject(tx: Transaction, subject: RoutingSubject): RoutingSubject {
  if (!subject || typeof subject !== 'object' ||
      !['session', 'entry', 'commitment'].includes(subject.kind) ||
      typeof subject.id !== 'string' || subject.id.trim().length === 0) {
    badRequest('invalid routing subject');
  }
  switch (subject.kind) {
    case 'session': readSession(tx, subject.id); break;
    case 'entry': readEntry(tx, subject.id); break;
    case 'commitment': readCommitment(tx, subject.id); break;
  }
  // Do not reflect body-like extra owner/class fields into the exact contract.
  return { kind: subject.kind, id: subject.id };
}

function toLabel(subject: RoutingSubject, row: SQLRow): RoutingLabel {
  return {
    subject,
    revision: Number(row.revision),
    dataClass: String(row.data_class) as RoutingDataClass,
    writer: String(row.writer) as RoutingLabel['writer'],
    recordedAt: new Date(Number(row.recorded_at)).toISOString(),
  };
}

export function current(tx: Transaction, subject: RoutingSubject): RoutingLabelLookup {
  const checked = existingSubject(tx, subject);
  const row = tx.get(
    'SELECT revision,data_class,writer,recorded_at FROM routing_labels WHERE subject_kind=? AND subject_id=? ORDER BY revision DESC LIMIT 1',
    [checked.kind, checked.id],
  );
  return row ? toLabel(checked, row) : { subject: checked, revision: 0, dataClass: 'unknown', writer: null, recordedAt: null };
}

export function history(tx: Transaction, subject: RoutingSubject): RoutingLabel[] {
  const checked = existingSubject(tx, subject);
  return tx.all(
    'SELECT revision,data_class,writer,recorded_at FROM routing_labels WHERE subject_kind=? AND subject_id=? ORDER BY revision',
    [checked.kind, checked.id],
  ).map(row => toLabel(checked, row));
}

function insert(tx: Transaction, subject: RoutingSubject, revision: number, dataClass: RoutingDataClass, writer: RoutingLabel['writer'], now: number): RoutingLabel {
  tx.run(
    'INSERT INTO routing_labels(subject_kind,subject_id,revision,data_class,writer,recorded_at) VALUES(?,?,?,?,?,?)',
    [subject.kind, subject.id, revision, dataClass, writer, now],
  );
  return { subject, revision, dataClass, writer, recordedAt: new Date(now).toISOString() };
}

// The owning create path has just inserted this subject in the caller's tx.
export function stamp(tx: Transaction, subject: RoutingSubject, label: TrustedWriteLabel, now: number): RoutingLabel {
  return insert(tx, subject, 1, label.dataClass, label.writer, now);
}

export function correct(tx: Transaction, input: RoutingLabelCorrection, now: number): RoutingLabel {
  if (!input || typeof input !== 'object' ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
      !['ordinary', 'private', 'sensitive'].includes(input.dataClass)) {
    badRequest('invalid routing label correction');
  }
  const prior = current(tx, input.subject);
  if (prior.revision !== input.expectedRevision) conflict(prior.subject.id, input.expectedRevision, prior.revision);
  return insert(tx, prior.subject, prior.revision + 1, input.dataClass, 'owner_review', now);
}
