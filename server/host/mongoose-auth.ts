import { MONGOOSE_ENDPOINTS, MONGOOSE_ENDPOINT_PATHS, mongooseEndpointName, mongooseTokenIdentity, type MongooseEndpoint } from '../connectors/mongoose.js';
import type { IdentityProof } from '../connectors/identity.js';
import {
  discoverProtectedResource, oauthAccessToken, onOrigin as oauthOnOrigin, readOAuthRecord, trustedOrigin, writeOAuthRecord,
  OAUTH_DISCOVERY_TIMEOUT_MS, OAUTH_LOCK_STALE_MS, OAUTH_RECORD_KEYS, OAUTH_RECORD_LIMIT, OAUTH_RECORD_SCHEMA, OAUTH_REFRESH_MARGIN_MS,
  OAuthCredentialError, type OAuthCredentialCode, type OAuthDiscoveryReason, type OAuthTokenOptions,
} from './oauth-client.js';

/**
 * Host-owned OAuth state for the Mongoose connector. One record per endpoint, one writer (this host),
 * one file in the private provider-config directory. A schemaVersion 3 record carries the OAuth tokens
 * bound to one RFC 8707 resource URL and is refreshed lazily, never on boot. The OAuth mechanics are
 * the shared client in oauth-client.ts; this module holds only what is Mongoose's own.
 */
export const MONGOOSE_RECORD_SCHEMA = OAUTH_RECORD_SCHEMA;
export const MONGOOSE_DISCOVERY_TIMEOUT_MS = OAUTH_DISCOVERY_TIMEOUT_MS;
export const MONGOOSE_OAUTH_KEYS = OAUTH_RECORD_KEYS;
export const MONGOOSE_RECORD_LIMIT = OAUTH_RECORD_LIMIT;
export const MONGOOSE_REFRESH_MARGIN_MS = OAUTH_REFRESH_MARGIN_MS;
/** The server caps one consent family at 90 absolute days; a refresh never extends it. */
export const MONGOOSE_CONSENT_CAP_MS = 90 * 24 * 60 * 60 * 1000;
/** One owner line when the consent family is close to its cap and re-consent is near. */
export const MONGOOSE_CONSENT_WARN_MS = 5 * 24 * 60 * 60 * 1000;
export const MONGOOSE_LOCK_STALE_MS = OAUTH_LOCK_STALE_MS;

export interface MongooseOAuthRecord {
  schemaVersion: typeof MONGOOSE_RECORD_SCHEMA;
  /** Which of the three endpoints this record signs in to; one record per endpoint. */
  endpoint: MongooseEndpoint;
  /** The canonical resource URL the grant is bound to: the configured origin plus the endpoint path. */
  resource: string;
  /** The authorization server that issued the grant: the configured origin. */
  issuer: string;
  /** Where the grant refreshes, on the issuer's origin. */
  tokenEndpoint: string;
  clientId: string;
  redirectPort: number;
  account: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when the access token stops being accepted. */
  expiresAt: number;
  /** Epoch milliseconds of the first consent in this family; the 90 day cap is measured from here. */
  consentStartedAt: number;
  /** The owner email the endpoint's own minted token named when the token check accepted it. */
  identity?: string;
}

/**
 * A refresh that never reached the server is its own code: a network blip is not a refusal, so the
 * host retries it instead of asking the owner to sign in again.
 */
export type MongooseCredentialCode = OAuthCredentialCode;
export { OAuthCredentialError as MongooseCredentialError };

/** One endpoint's resource identity, computed once from trusted configuration, never from a discovery document. */
export interface MongooseBinding { endpoint: MongooseEndpoint; resource: string; issuer: string }

/**
 * The binding a configured endpoint URL implies: its origin plus that endpoint's own path. A URL with
 * userinfo, a query, a fragment, another path or a transport the catalogue refuses has no binding.
 */
export function mongooseBinding(configuredUrl: string, endpoint: MongooseEndpoint): MongooseBinding | undefined {
  let url: URL;
  try { url = new URL(configuredUrl); } catch { return undefined; }
  if (!trustedOrigin(url) || url.pathname.replace(/\/$/, '') !== MONGOOSE_ENDPOINT_PATHS[endpoint]) return undefined;
  return { endpoint, resource: `${url.origin}${MONGOOSE_ENDPOINT_PATHS[endpoint]}`, issuer: url.origin };
}

/** The binding of one catalogue entry, by its resource label or its path; undefined for anything else. */
export function mongooseEntryBinding(entry: { resource: string; url?: string | undefined }): MongooseBinding | undefined {
  if (typeof entry.url !== 'string') return undefined;
  const endpoint = mongooseEndpointName(entry.resource) ?? mongooseEndpointName(entry.url);
  return endpoint === undefined ? undefined : mongooseBinding(entry.url, endpoint);
}

/** An https (or literal loopback) URL on exactly this origin, with no userinfo or fragment. */
export const onOrigin = oauthOnOrigin;

/** A stored record is a Mongoose record only for one of the three endpoints and its own binding. */
function acceptMongoose(endpoint: string, resource: string): MongooseBinding | undefined {
  return (MONGOOSE_ENDPOINTS as readonly string[]).includes(endpoint) ? mongooseBinding(resource, endpoint as MongooseEndpoint) : undefined;
}

/** Strict read of one schemaVersion 3 record; undefined for a missing, v1, v2 or malformed file. */
export function readMongooseOAuth(configDir: string, reference: string): MongooseOAuthRecord | undefined {
  return readOAuthRecord(configDir, reference, acceptMongoose) as MongooseOAuthRecord | undefined;
}

/** Atomic replace: a private temp file in the same directory, then one rename. */
export function writeMongooseOAuth(configDir: string, reference: string, record: MongooseOAuthRecord): void {
  writeOAuthRecord(configDir, reference, record);
}

/** Why one endpoint's discovery was refused, a closed set the host log may name. */
export type MongooseDiscoveryReason = OAuthDiscoveryReason;

/**
 * RFC 9728 discovery of one endpoint's protected-resource document, fetched only from the configured
 * origin with no redirect followed. Its `resource` must equal the expected URL exactly and its first
 * authorization server must be the configured origin, so a sibling endpoint's document is refused.
 */
export function discoverMongooseResource(
  post: typeof fetch, binding: MongooseBinding, timeoutMs = MONGOOSE_DISCOVERY_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; reason: MongooseDiscoveryReason }> {
  return discoverProtectedResource(post, binding, timeoutMs);
}

/**
 * One 401 that advertises its protected-resource document is the token being refused for this endpoint:
 * a closed credential reason for this endpoint only, never a retry against another endpoint. Any other
 * status is not that verdict.
 */
export function mongooseCredentialRefusal(status: number, resourceMetadata: string | undefined): 'credential-unavailable' | undefined {
  return status === 401 && resourceMetadata !== undefined && resourceMetadata.length > 0 ? 'credential-unavailable' : undefined;
}

/** The startup presence check: a usable record exists, without refreshing and without any network. */
export function mongooseCredentialPresent(configDir: string, reference: string): boolean {
  const record = readMongooseOAuth(configDir, reference);
  return record !== undefined && record.refreshToken.length > 0;
}

export interface MongooseAuthOptions extends OAuthTokenOptions {
  /** The catalogue's one owner email; every minted token must name it, or the token is never used. */
  ownerIdentity?: string | null;
  /**
   * The one receipt per token check (#696): proven, matched and a closed code, never the claim itself.
   * It runs at the first connect and after every refresh, from the JWT check this module already does.
   */
  onIdentity?: (proof: IdentityProof) => void;
}

/**
 * The access token for one endpoint. The record must be bound to exactly the binding the current
 * configuration implies; any other record, or no binding, is a sign-in and never a refresh.
 */
export function mongooseAccessToken(configDir: string, reference: string, binding: MongooseBinding | undefined, options: MongooseAuthOptions = {}): Promise<string> {
  const { ownerIdentity, ...token } = options;
  const expected = typeof ownerIdentity === 'string' && ownerIdentity.length > 0 ? [ownerIdentity] : [];
  const endpoint = binding?.endpoint;
  return oauthAccessToken(configDir, reference, binding, {
    accept: acceptMongoose, consentCapMs: MONGOOSE_CONSENT_CAP_MS, consentWarnMs: MONGOOSE_CONSENT_WARN_MS,
    // Council 2026-10-26 (option B): the endpoint's own minted JWT is the identity proof. A token for
    // another account, or for another endpoint's audience, is never used and never stored. With no
    // ownerIdentity configured there is nothing to compare, which is the catalogue's explicit
    // no-comparison policy, not a fallback: the token is still decoded and its audience checked.
    verifyToken: accessToken => {
      if (endpoint === undefined) return undefined;
      const proof = mongooseTokenIdentity(accessToken, endpoint, expected);
      options.onIdentity?.(proof);
      if (proof.match === false) return { ok: false as const, code: 'identity_mismatch' as const };
      if (!proof.proven && expected.length > 0) return { ok: false as const, code: 'identity_unverified' as const };
      // The claim the issuer minted is what the sign-in record keeps, so Settings can name the account.
      return { ok: true as const, ...(proof.proven && typeof proof.value === 'string' && proof.value.length > 0 ? { identity: proof.value } : {}) };
    },
  }, token);
}
