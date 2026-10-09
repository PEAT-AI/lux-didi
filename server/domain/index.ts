// Lux Didi domain: source-backed memory/commitment logic over a service
// Transaction. The domain never opens a database and performs no side effects;
// the facade composes each mutation with its reminder outbox effect inside one
// runtime transaction. See docs/domain-contract.md.
export * from './contract.ts';
export * from './schema.ts';
export * from './util.ts';
export * as memory from './memory.ts';
export * as commitments from './commitments.ts';
export * as dto from './dto.ts';
export * from './facade.ts';
