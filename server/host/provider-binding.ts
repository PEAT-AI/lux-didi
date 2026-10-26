import { createHash } from 'node:crypto';
import { credentialReceiptFor, requestCredentialsFor, seedScope, type CredentialRouteScope, type ProviderStatus } from '../config/index.js';
import { ConfigError } from '../config/files.js';
import { GeminiAdapter, type Credentials, type ModelPort, type Transport } from '../adapters/model/index.js';
import { assertGeminiBinding } from '../adapters/model/gemini.js';

export interface ProviderBindingIdentity { readonly accountSha256: string; readonly generation: string }
/** Currentness changes only at an outbound invocation or explicit host boundary, never per media event. */
export function pinProviderBinding(configDir: string, scope: CredentialRouteScope) {
  const expected = credentialReceiptFor(configDir, scope), expectedBytes = JSON.stringify(expected);
  const identity: ProviderBindingIdentity = Object.freeze({ accountSha256: createHash('sha256').update(expected.configuredAccount).digest('hex'), generation: expected.bindingGeneration });
  let current = true, invalidated: (() => void) | undefined;
  const refuse = (): never => { if (current) { current = false; invalidated?.(); } throw new ConfigError('binding_changed'); };
  return Object.freeze({
    identity, current: () => current,
    onInvalidated(callback: () => void) { invalidated = callback; if (!current) callback(); },
    check() { try { if (!current || JSON.stringify(credentialReceiptFor(configDir, scope)) !== expectedBytes) refuse(); } catch { refuse(); } },
    credentials(): Credentials {
      const invocation = requestCredentialsFor(configDir, scope);
      return { resolve: async reference => {
        if (!current) refuse();
        try {
          const key = await invocation.credentials.resolve(reference);
          if (!current || JSON.stringify(invocation.resolvedReceipt()) !== expectedBytes) refuse();
          return key;
        } catch { return refuse(); }
      } };
    },
  });
}
export type PinnedProviderBinding = ReturnType<typeof pinProviderBinding>;
/** All three text consumers use this exact profile route and one receipt per generation request. */
export function boundTextModel(configDir: string, loaded: Extract<ProviderStatus, { status: 'ready' }>, testing?: { credentials?: Credentials; transport?: Transport }): { model: ModelPort; binding?: PinnedProviderBinding } {
  // Validate the provider wiring here, at composition: a model this adapter cannot serve is then an
  // ADAPTER_CONFIGURATION_INVALID status the host reports at start instead of a first-answer failure.
  assertGeminiBinding(loaded.profile.modelId, loaded.profile.keyReference);
  const scope = seedScope('gemini', loaded.profile.modelId, loaded.profile.dataClasses);
  const binding = testing?.credentials ? undefined : pinProviderBinding(configDir, scope);
  const model: ModelPort = { generate(request, control) {
    const credentials = testing?.credentials ?? binding!.credentials();
    return new GeminiAdapter({ modelId: loaded.profile.modelId, keyReference: loaded.profile.keyReference, route: loaded.route, credentials,
      ...(testing?.transport ? { transport: testing.transport } : {}) }).generate(request, control);
  } };
  return { model, ...(binding ? { binding } : {}) };
}
