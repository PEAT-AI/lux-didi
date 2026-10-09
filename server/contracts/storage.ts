export type SQLValue = null | number | bigint | string | Uint8Array;
export type SQLRow = Record<string, SQLValue>;
export interface SchemaMigration { owner: string; version: number; statements: readonly string[] }
export interface Transaction {
  run(sql: string, params?: readonly SQLValue[]): number;
  all(sql: string, params?: readonly SQLValue[]): SQLRow[];
  get(sql: string, params?: readonly SQLValue[]): SQLRow | undefined;
}
export interface StorePort {
  readonly authorityEpoch: string;
  transaction<T>(body: (tx: Transaction) => T extends PromiseLike<unknown> ? never : T): T;
  close(): void;
}
