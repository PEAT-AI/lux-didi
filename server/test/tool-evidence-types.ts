import type { CompletedResult } from '../adapters/mcp/port.js';
import type { ConnectorEvidence } from '../connectors/index.js';
import type { GoogleEvidence } from '../connectors/google.js';
import type { LuxKnowledgeEvidence } from '../connectors/lux-knowledge.js';
import type { MongooseEvidence } from '../connectors/mongoose.js';
import type { MattermostEvidence } from '../connectors/mattermost.js';

type RequiresDecoded<T> = T extends { decodedResult: unknown } ? true : false;
type Assert<T extends true> = T;
export type CompletedHandoff = Assert<RequiresDecoded<CompletedResult>>;
export type SharedHandoff = Assert<RequiresDecoded<ConnectorEvidence>>;
export type GoogleHandoff = Assert<RequiresDecoded<GoogleEvidence>>;
export type LuxHandoff = Assert<RequiresDecoded<LuxKnowledgeEvidence>>;
export type MongooseHandoff = Assert<RequiresDecoded<MongooseEvidence>>;
export type MattermostHandoff = Assert<RequiresDecoded<MattermostEvidence>>;
