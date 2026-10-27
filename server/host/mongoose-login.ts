import { runOAuthLogin, OAuthLoginError, OAUTH_ERRORS, OAUTH_LOGIN_TIMEOUT_MS, type OAuthError, type OAuthLoginCode, type OAuthProvider, type OAuthSignInHop } from './oauth-client.js';
import { mongooseBinding, type MongooseOAuthRecord } from './mongoose-auth.js';
import { mongooseTokenIdentity, type MongooseEndpoint } from '../connectors/mongoose.js';

/**
 * The owner's one-time Mongoose sign-in through the shared OAuth client: the endpoint's own resource
 * URL, the configured origin as issuer, one dynamic client registration, PKCE S256, a loopback callback,
 * one code exchange and one atomic record write. It never runs on a host boot and never prints a token.
 */
export const MONGOOSE_LOGIN_CLIENT_NAME = 'lux-didi';
export const MONGOOSE_LOGIN_SCOPE = 'mcp';
export const MONGOOSE_LOGIN_PORT = 8768;
export const MONGOOSE_LOGIN_TIMEOUT_MS = OAUTH_LOGIN_TIMEOUT_MS;

export type MongooseLoginCode = OAuthLoginCode;
export { OAuthLoginError as MongooseLoginError };
export const MONGOOSE_OAUTH_ERRORS = OAUTH_ERRORS;
export type MongooseOAuthError = OAuthError;
export type MongooseSignInHop = OAuthSignInHop;

export const MONGOOSE_PROVIDER: OAuthProvider = { scope: MONGOOSE_LOGIN_SCOPE, clientName: MONGOOSE_LOGIN_CLIENT_NAME, label: 'Mongoose', defaultPort: MONGOOSE_LOGIN_PORT };

export interface MongooseLoginOptions {
  /** Absolute private configuration directory that receives the record. */
  configDir: string;
  /** Credential reference from the endpoint policy (`mongoose-knowledge`, `mongoose-data`, `mongoose-crm`). */
  reference: string;
  /** The endpoint's configured MCP URL; its origin plus the endpoint path is the one resource identity. */
  resourceUrl: string;
  /** Which of the three endpoints this sign-in binds; it decides the resource and the record. */
  endpoint: MongooseEndpoint;
  account: string;
  /** The catalogue's one owner email: the sign-in asks for it and every caught token must name it. */
  ownerIdentity?: string | null;
  redirectPort?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Hands the authorize URL to the owner's default browser; a test supplies its own. */
  openBrowser?: (url: string) => void | Promise<void>;
  /** Present the sign-in URL without opening a browser; takes precedence over openBrowser. */
  showAuthorizationUrl?: (url: string) => void;
  /** One content-free line per hop, for the host log and the Settings row. */
  onHop?: (hop: MongooseSignInHop) => void;
  now?: () => number;
}

export async function runMongooseLogin(options: MongooseLoginOptions): Promise<MongooseOAuthRecord> {
  const { resourceUrl, endpoint, ownerIdentity, ...rest } = options;
  // The owner email is asked for twice: `expected_email` is Mongoose's own refusal before any code is
  // minted (wagon M1), `login_hint` is Google's account prefill. Against a Mongoose that ignores both,
  // the token claim check below is the guard, so this works with today's server too.
  const expected = typeof ownerIdentity === 'string' && ownerIdentity.length > 0 ? [ownerIdentity] : [];
  return await runOAuthLogin({
    ...rest,
    ...(expected.length > 0 ? { expectedEmail: ownerIdentity! } : {}),
    // No ownerIdentity configured is the catalogue's explicit no-comparison policy: the token is still
    // decoded and its audience checked, and only a configured owner email is refused on a mismatch. The
    // claim the check proved rides into the record, so Settings can say who this endpoint signed in as.
    verifyToken: (accessToken: string) => {
      const proof = mongooseTokenIdentity(accessToken, endpoint, expected);
      if (proof.match === false) return { ok: false as const, code: 'identity_mismatch' as const };
      if (!proof.proven && expected.length > 0) return { ok: false as const, code: 'identity_unverified' as const };
      return { ok: true as const, ...(proof.proven && typeof proof.value === 'string' && proof.value.length > 0 ? { identity: proof.value } : {}) };
    },
    provider: MONGOOSE_PROVIDER,
    binding: mongooseBinding(resourceUrl, endpoint),
  }) as MongooseOAuthRecord;
}
