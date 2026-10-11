import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ConfigError, currentUid, fail, fields, parseJson, validateFile, validateOwner, validateRoot } from './files.js';
import { PUBLIC_PERSONA, publicOwnerProfile, validateOwnerProfile, type OwnerProfileSnapshot } from '../prompt/index.js';

export type OwnerProfileFaultPhase = 'validation' | 'temp' | 'write' | 'file-sync' | 'backup' | 'rename' | 'directory-sync';
export interface OwnerProfileTesting { fault?(phase: OwnerProfileFaultPhase): void }
export class OwnerProfileWriteError extends Error {
  constructor(readonly uncertain: boolean) { super(uncertain ? 'Profile durability is uncertain; read back before another save.' : 'Profile could not be saved.'); }
}
export class OwnerProfileConflict extends Error { constructor() { super('Saved profile changed; reload intentionally before saving.'); } }
interface DiskState { profile: OwnerProfileSnapshot; revision: string; present: boolean }
export interface OwnerProfileDocument {
  publicBase: string;
  active: { profile: OwnerProfileSnapshot; revision: string };
  saved: DiskState;
  previous: OwnerProfileSnapshot | null;
  pendingActivation: boolean;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** One host-owned target, immutable active capture, and synchronous serialized CAS writes.
 * Trusted ancestors and same-UID path replacement have the same limits as config/files.
 * Backup and current are separate atomic transactions, never a two-rename transaction.
 */
export class OwnerProfileStore {
  readonly active: { readonly profile: OwnerProfileSnapshot; readonly revision: string };
  readonly status: 'default' | 'configured';
  readonly #previousPath: string;
  constructor(readonly path: string, readonly ownerId: string, readonly allowAbsent: boolean, readonly testing?: OwnerProfileTesting) {
    this.#previousPath = path + '.previous-good.json';
    const state = this.#read(path, allowAbsent);
    this.active = Object.freeze({ profile: state.profile, revision: state.revision });
    this.status = state.present ? 'configured' : 'default';
  }
  #phase(phase: OwnerProfileFaultPhase) { this.testing?.fault?.(phase); }
  #read(path: string, allowAbsent: boolean): DiskState {
    if (!validateRoot(dirname(path))) fail('file_missing');
    let initial;
    try { initial = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!allowAbsent) fail('file_missing');
      return { profile: publicOwnerProfile(this.ownerId), revision: hash('absent:' + this.ownerId), present: false };
    }
    if (initial.isSymbolicLink()) fail('file_symlink');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd); validateFile(stat, 65_536);
      if (stat.ino !== initial.ino || stat.dev !== initial.dev) fail('file_type');
      const bytes = Buffer.alloc(65_537); let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > 65_536) fail('too_large');
      const content = bytes.subarray(0, length);
      let text: string;
      // Match the established fatal UTF-8 reader, including stripping a leading BOM.
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); } catch { return fail('invalid_utf8'); }
      let profile: OwnerProfileSnapshot;
      try { profile = validateOwnerProfile(parseJson(text), this.ownerId); } catch { return fail('invalid_profile'); }
      if (profile.kind !== 'profile') fail('invalid_profile');
      const after = fstatSync(fd); validateFile(after, 65_536);
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) fail('io_error');
      const identity = [after.dev, after.ino, after.uid, after.mode, after.nlink, after.size, after.mtimeMs, after.ctimeMs];
      // Identity uses original bytes, not BOM-stripped/parsed/canonicalized content.
      const revision = createHash('sha256').update(JSON.stringify(identity) + '\n').update(content).digest('hex');
      return { profile, revision, present: true };
    } finally { closeSync(fd); }
  }
  get(): OwnerProfileDocument {
    const saved = this.#read(this.path, this.allowAbsent);
    let previous: OwnerProfileSnapshot | null = null;
    // A corrupt/unsafe previous copy is unavailable, never a fallback for current.
    try { const old = this.#read(this.#previousPath, true); if (old.present) previous = old.profile; } catch { /* unavailable */ }
    return { publicBase: PUBLIC_PERSONA, active: this.active, saved, previous,
      pendingActivation: JSON.stringify(saved.profile) !== JSON.stringify(this.active.profile) };
  }
  #directory(): number {
    const parent = dirname(this.path);
    if (!validateRoot(parent)) fail('file_missing');
    const initial = lstatSync(parent), fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isDirectory() || stat.ino !== initial.ino || stat.dev !== initial.dev) fail('directory_type');
      validateOwner(stat, currentUid(), 'directory_owner');
      if ((stat.mode & 0o7777) !== 0o700) fail('directory_mode');
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }
  #temporary(profile: OwnerProfileSnapshot, inject: boolean): string {
    const path = join(dirname(this.path), '.owner-profile-' + randomUUID() + '.tmp');
    if (inject) this.#phase('temp');
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let ready = false;
    try {
      try {
        fchmodSync(fd, 0o600);
        const bytes = Buffer.from(JSON.stringify(profile, null, 2) + '\n', 'utf8');
        if (inject) this.#phase('write');
        let offset = 0;
        while (offset < bytes.length) {
          const count = writeSync(fd, bytes, offset, bytes.length - offset);
          if (count === 0) throw new Error('Incomplete protected write');
          offset += count;
        }
        if (inject) this.#phase('file-sync');
        fsyncSync(fd);
      } finally { closeSync(fd); }
      ready = true;
      return path;
    } finally { if (!ready) unlinkSync(path); }
  }
  /** No await between revision comparison and replacement: this host's saves cannot interleave. */
  put(raw: unknown): OwnerProfileDocument {
    let input: Record<string, unknown>, profile: OwnerProfileSnapshot;
    try {
      input = fields(raw, ['expectedRevision', 'displayName', 'style', 'lore'], 'invalid_profile');
      if (typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) fail('invalid_profile');
      profile = validateOwnerProfile({ schemaVersion: 1, kind: 'profile', ownerId: this.ownerId,
        profileVersion: randomUUID(), displayName: input.displayName, style: input.style, lore: input.lore }, this.ownerId);
    } catch { return fail('invalid_profile'); }
    let temporary: string | undefined, replaced = false;
    try {
      this.#phase('validation');
      const current = this.#read(this.path, this.allowAbsent);
      if (input.expectedRevision !== current.revision) throw new OwnerProfileConflict();
      // Validate existing backup boundary/content before writing even a staged draft.
      if (current.present) this.#read(this.#previousPath, true);
      const directory = this.#directory();
      try {
        temporary = this.#temporary(profile, true);
        if (current.present) {
          this.#phase('backup');
          let backup: string | undefined = this.#temporary(current.profile, false);
          try { renameSync(backup, this.#previousPath); backup = undefined; fsyncSync(directory); }
          finally { if (backup !== undefined) unlinkSync(backup); }
        }
        // Detect a cooperative external replacement during the independent backup transaction.
        if (this.#read(this.path, this.allowAbsent).revision !== current.revision) throw new OwnerProfileConflict();
        this.#phase('rename');
        renameSync(temporary, this.path); temporary = undefined; replaced = true;
        this.#phase('directory-sync');
        fsyncSync(directory);
        return this.get();
      } finally { closeSync(directory); }
    } catch (error) {
      if (replaced) throw new OwnerProfileWriteError(true);
      if (error instanceof OwnerProfileConflict || error instanceof ConfigError) throw error;
      throw new OwnerProfileWriteError(false);
    } finally { if (temporary !== undefined) unlinkSync(temporary); }
  }
}
