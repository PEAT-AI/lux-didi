import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

export const FIND_FILE_SCHEMA = {
  name: 'find_file',
  description: 'Search local Spotlight by file name or content words. Returns up to 20 paths, names and modified dates, newest first, never file bodies. Content-only matches are outside text.',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
} as const;

export interface FindFilePort {
  run(command: string, args: readonly string[]): Promise<string>;
  stat(path: string): Promise<{ mtime: Date }>;
}
const defaultPort: FindFilePort = {
  run: (command, args) => new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  }),
  stat,
};
export interface FoundFile { path: string; name: string; modified: string; outsideText: boolean }
export interface FindFileResult { code: 'found' | 'empty' | 'unavailable' | 'invalid_arguments'; files: FoundFile[] }

/** Escape Spotlight predicate syntax, not shell syntax. execFile never invokes a shell. */
function literal(word: string): string { return word.replace(/[\\"*?]/g, '\\$&'); }
export async function findFile(args: unknown, overrides: Partial<FindFilePort> = {}): Promise<FindFileResult> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { code: 'invalid_arguments', files: [] };
  const value = args as Record<string, unknown>;
  if (Object.keys(value).join(',') !== 'query' || typeof value.query !== 'string' || !value.query.trim() || value.query.includes('\0')) return { code: 'invalid_arguments', files: [] };
  const port = { ...defaultPort, ...overrides };
  const words = value.query.trim().split(/\s+/).map(literal);
  const predicate = (field: string): string => words.map(word => `${field} == "*${word}*"cd`).join(' && ');
  try {
    // Separate result sets preserve provenance: a name match is not outside text.
    const names = new Set((await port.run('/usr/bin/mdfind', ['-0', predicate('kMDItemFSName')])).split('\0').filter(Boolean));
    const content = (await port.run('/usr/bin/mdfind', ['-0', predicate('kMDItemTextContent')])).split('\0').filter(Boolean);
    const files: FoundFile[] = [];
    for (const path of new Set([...names, ...content])) {
      try {
        const info = await port.stat(path);
        files.push({ path, name: basename(path), modified: info.mtime.toISOString(), outsideText: !names.has(path) });
      } catch { /* A removed or unreadable result is no longer a usable local file. */ }
    }
    files.sort((a, b) => b.modified.localeCompare(a.modified) || a.path.localeCompare(b.path));
    return { code: files.length ? 'found' : 'empty', files: files.slice(0, 20) };
  } catch { return { code: 'unavailable', files: [] }; }
}
