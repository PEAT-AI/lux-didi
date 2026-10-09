// Lux Didi domain: source-backed memory/commitment logic over a service
// Transaction. The domain never opens a database and performs no side effects;
// the facade composes each mutation with its reminder outbox effect inside one
// runtime transaction. See docs/domain-contract.md.
export * from './contract.js';
export * from './schema.js';
export * from './util.js';
export * as memory from './memory.js';
export * as commitments from './commitments.js';
export * as dto from './dto.js';
export * from './facade.js';
