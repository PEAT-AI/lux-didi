import { createHash } from 'node:crypto';

/** JSON DTOs only. Read descriptors, never getters/toJSON; UTF8 is the stored/hash encoding. */
export function canonicalJSON(value: unknown): string {
  const active = new Set<object>();
  const visit = (entry: unknown): string => {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return JSON.stringify(entry);
    if (typeof entry === 'number' && Number.isFinite(entry)) return JSON.stringify(entry);
    if (typeof entry !== 'object' || entry === null || active.has(entry)) throw Error('unsupported_canonical_value');
    active.add(entry);
    try {
      const array = Array.isArray(entry);
      if (Object.getPrototypeOf(entry) !== (array ? Array.prototype : Object.prototype) && !(Object.getPrototypeOf(entry) === null && !array)) throw Error('unsupported_canonical_object');
      const keys = Reflect.ownKeys(entry);
      if (keys.some(k => typeof k !== 'string')) throw Error('unsupported_canonical_key');
      const descriptors = Object.getOwnPropertyDescriptors(entry);
      if (array) {
        if (keys.length !== entry.length + 1) throw Error('unsupported_canonical_array');
        const values: string[] = [];
        for (let i = 0; i < entry.length; i++) {
          const d = descriptors[String(i)];
          if (!d || !('value' in d) || !d.enumerable) throw Error('unsupported_canonical_array');
          values.push(visit(d.value));
        }
        return `[${values.join(',')}]`;
      }
      return `{${(keys as string[]).sort().map(key => {
        const d = descriptors[key]!;
        if (!('value' in d) || !d.enumerable) throw Error('unsupported_canonical_property');
        return `${JSON.stringify(key)}:${visit(d.value)}`;
      }).join(',')}}`;
    } finally { active.delete(entry); }
  };
  return visit(value);
}
export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const detached = <T>(value: T): T => JSON.parse(canonicalJSON(value)) as T;
