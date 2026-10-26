// Fixed instructions only, never provider payloads or credential contents.
/** The eight connector rows the host can emit: the release 11 catalogue (server/test/fixtures/installed-mcp-config.json) and the Trello board (W7-R3). */
export const connectorIDs = ["lux-knowledge", "gmail", "calendar", "mattermost", "mongoose-knowledge", "mongoose-data", "mongoose-crm", "trello"] as const;
/** The ten reason codes the host's connectionReasonCode can return (server/http/server.ts). */
export const reasonCodes = ["configuration_error", "credential_missing", "needs_sign_in", "not_signed_in", "not_configured", "unreachable", "discovery_failed", "handshake_failed", "identity_mismatch", "unknown"] as const;
export type ReasonCode = (typeof reasonCodes)[number];

/** The three Mongoose endpoints, each its own OAuth resource with its own sign-in. */
const mongooseNames: Record<string, "knowledge" | "data" | "crm"> = {
  "mongoose-knowledge": "knowledge", "mongoose-data": "data", "mongoose-crm": "crm",
};
const mongooseLabels = { knowledge: "Mongoose knowledge", data: "Mongoose data", crm: "Mongoose CRM" } as const;
export type MongooseEndpointName = keyof typeof mongooseLabels;
/** The endpoint name a row id signs in, or undefined: only these three rows can be signed in. */
export function mongooseEndpoint(id: string): MongooseEndpointName | undefined {
  return Object.hasOwn(mongooseNames, id) ? mongooseNames[id] : undefined;
}
export function mongooseEndpointLabel(name: MongooseEndpointName): string { return mongooseLabels[name]; }
/** Every row an owner signs in to from Settings: the three Mongoose endpoints and the Trello board. */
export type SignInName = MongooseEndpointName | "trello";
// D2: the Trello board is connected by an imported API key, so it has no sign-in to offer.
export function signInTarget(id: string): SignInName | undefined { return id === "trello" ? undefined : mongooseEndpoint(id); }
export function signInLabel(name: SignInName): string { return name === "trello" ? "Trello" : mongooseEndpointLabel(name); }

export interface NextStep { text: string; guideUrl?: string; command?: string; signIn?: boolean }
const setupGuideUrl = "https://github.com/PEAT-AI/lux-didi/blob/main/docs/user-guide.md#connector-setup";
const mcpGuideUrl = "https://github.com/PEAT-AI/lux-didi/blob/main/docs/mcp-configuration.md";
/** One sign-in row: the Settings button does the work, so this carries no command. */
const signInStep = (label: string): NextStep => ({ text: `Sign in to ${label} in Settings: the Sign in button is on the ${label} row, and the connector reconnects by itself when you finish.`, guideUrl: setupGuideUrl, signIn: true });
/** A transport timeout: Naya retries on its own, so the owner is told that, not asked to fix anything. */
const unreachableStep = (label: string): NextStep => ({ text: `${label} is not reachable right now. Naya retries in the background and reconnects by itself when Mongoose answers.` });
/** The same failure after the bounded retries are spent: the stored login may be the cause, so the
 * Settings sign-in button is offered as the owner's way out. */
const unreachableSpentStep = (label: string): NextStep => ({ text: `${label} is not reachable and Naya has stopped retrying. Sign in again in Settings if your stored login has expired, or reconnect from the Lux Didi menu.`, guideUrl: setupGuideUrl, signIn: true });
/** The Mongoose rows' own steps for the reasons the generic table answers with a restart: none of them is fixed by one. */
const mongooseReasonSteps: Partial<Record<ReasonCode, (label: string) => NextStep>> = {
  configuration_error: label => ({ text: `The ${label} entry in your connector configuration needs a fix: a missing data class, or a changed tool list that needs your approval. Follow the MCP configuration guide; Lux Didi reads that file when it starts, so the change applies from its next start.`, guideUrl: mcpGuideUrl }),
  discovery_failed: label => ({ text: `${label} answered, but its tool list could not be read. Use Copy diagnostics from the Lux Didi menu; the connector_failure line in host.log names the cause.` }),
  handshake_failed: label => ({ text: `${label} did not finish connecting. Check that the VPN is on and Mongoose is up; if it stays failed, use Copy diagnostics from the Lux Didi menu.` }),
  // W7-R2: the board name is the owner's private configuration, so the row says where it goes.
  not_configured: label => ({ text: `${label} has no board name yet. Write {"board": "<the name you see in Trello>"} to trello-board.json in the protected configuration directory, then reopen Settings.`, guideUrl: mcpGuideUrl }),
  identity_mismatch: label => ({ text: `${label} is signed in as a different account than your configuration names. Use the Sign in button and sign in with the account your configuration names; a refused account is not retried, so the endpoint connects with the new sign-in from Lux Didi's next start.`, guideUrl: setupGuideUrl, signIn: true }),
};
/** D2: the Trello board is connected by the owner's own API key, so its row names the import command. */
const trelloKeyStep = (label: string): NextStep => ({ text: `${label} uses the API key and token you already have. Run scripts/import-trello-key.sh <env-file> <config-dir> once, then write {"board": "<the name you see in Trello>", "ownerIdentity": "<your Trello email>"} to trello-board.json in the protected configuration directory and reopen Settings.`, guideUrl: mcpGuideUrl });
const failureStep: NextStep = { text: "Check the connector service, then use Copy diagnostics from the Lux Didi menu." };
/** Mongoose signs in through the browser; the pasted-token path covers the other connectors only. */
const mongooseCredentialStep = (label: string): NextStep => ({ text: `${label} has no stored session. Use the Sign in button on its row in Settings once this endpoint is in your connector configuration.`, guideUrl: setupGuideUrl });
const credentialSteps: Record<string, NextStep> = {
  "lux-knowledge": { text: "Configure this connector and its credentials in your explicitly selected protected configuration directory. Use the Setup guide, then restart Lux Didi.", guideUrl: setupGuideUrl },
  "gmail": { text: "Configure this connector and its credentials in your explicitly selected protected configuration directory. Use the Setup guide, then restart Lux Didi.", guideUrl: setupGuideUrl },
  "calendar": { text: "Configure this connector and its credentials in your explicitly selected protected configuration directory. Use the Setup guide, then restart Lux Didi.", guideUrl: setupGuideUrl },
  "mattermost": { text: "Configure this connector and its credentials in your explicitly selected protected configuration directory. Use the Setup guide, then restart Lux Didi.", guideUrl: setupGuideUrl },
  "mongoose-knowledge": mongooseCredentialStep("Mongoose knowledge"),
  "mongoose-data": mongooseCredentialStep("Mongoose data"),
  "mongoose-crm": mongooseCredentialStep("Mongoose CRM"),
};
/** One fixed sentence per reason code, so no row with a known reason falls back to the failure text. */
const reasonSteps: Record<ReasonCode, NextStep> = {
  configuration_error: { text: "This connector's tool list changed and needs your approval. Approve the new tool list with the approve command the MCP configuration guide describes, then restart Lux Didi.", guideUrl: mcpGuideUrl },
  credential_missing: credentialSteps["lux-knowledge"]!,
  needs_sign_in: { text: "This connector needs a fresh sign-in with its own credentials. Sign in with its own command, then restart Lux Didi.", guideUrl: setupGuideUrl },
  not_configured: { text: "This connector has no configuration yet. Add its settings, then restart Lux Didi.", guideUrl: setupGuideUrl },
  not_signed_in: { text: "This connector has no active session. Sign in again with its own credentials, then restart Lux Didi.", guideUrl: setupGuideUrl },
  unreachable: { text: "The connector service is not reachable right now. Start it, then restart Lux Didi.", guideUrl: setupGuideUrl },
  discovery_failed: { text: "Tool discovery failed for this connector. Check its service tool configuration, then restart Lux Didi." },
  handshake_failed: { text: "This connector's handshake failed. Check that its service is ready, then restart Lux Didi." },
  identity_mismatch: { text: "This connector is signed in as a different account. Sign in again with the account your configuration names, then restart Lux Didi." },
  unknown: failureStep,
};

export function nextStep(id: string, state: string, reason?: string, retrying = false): NextStep {
  if (state === 'connected') return { text: 'no action needed' };
  if (state === 'configured') return { text: 'a Live session connects on demand' };
  if (id === 'trello' && reason !== undefined && ['not_configured', 'not_signed_in', 'needs_sign_in', 'credential_revoked'].includes(reason)) return trelloKeyStep('Trello');
  const endpoint = mongooseEndpoint(id);
  if (endpoint) {
    const label = mongooseEndpointLabel(endpoint);
    // A signed-out or expired Mongoose endpoint is signed in from Settings, one endpoint at a time.
    if (reason === 'needs_sign_in' || reason === 'not_signed_in') return signInStep(label);
    if (reason === 'unreachable') return retrying ? unreachableStep(label) : unreachableSpentStep(label);
    const own = reason !== undefined && Object.hasOwn(mongooseReasonSteps, reason) ? mongooseReasonSteps[reason as ReasonCode] : undefined;
    if (own) return own(label);
  }
  if (state === 'missing' || reason === 'credential_missing') return Object.hasOwn(credentialSteps, id) ? credentialSteps[id]! : credentialSteps['lux-knowledge']!;
  return Object.hasOwn(reasonSteps, reason ?? '') ? reasonSteps[reason as ReasonCode]! : failureStep;
}
