// Fixed instructions only, never provider payloads or credential contents.
export const connectorIDs = ["lux-knowledge", "gmail", "calendar", "mattermost", "mongoose"] as const;
export const reasonCodes = ["credential_missing", "unreachable", "discovery_failed", "handshake_failed", "unknown"] as const;
export interface NextStep { text: string; command?: string }
const credentialSteps: Record<string, NextStep> = {
  "lux-knowledge": { text: "Add the connector credential under the effective data directory; see RUNBOOK, then restart Lux Didi." },
  "gmail": { text: "Add the connector credential under the effective data directory; see RUNBOOK, then restart Lux Didi." },
  "calendar": { text: "In /Users/rob/GitHub/lux-cli run uv run --package lux-gcal gcal --auth, finish browser sign-in, then restart Lux Didi.", command: "cd /Users/rob/GitHub/lux-cli && uv run --package lux-gcal gcal --auth" },
  "mattermost": { text: "Add the connector credential under the effective data directory; see RUNBOOK, then restart Lux Didi." },
  "mongoose": { text: "Add ~/Library/Application Support/ai.peat.lux-didi/provider-38/mongoose-mcp.json; see RUNBOOK-connectors.md (RUNBOOK), then restart Lux Didi." },
};
const failureStep: NextStep = { text: "Check the connector service, then use Copy diagnostics from the Lux Didi menu." };
export const nextSteps: Record<string, Record<string, NextStep>> = Object.fromEntries(connectorIDs.map(id => [
  id, Object.fromEntries(reasonCodes.map(reason => [reason, reason === 'credential_missing' ? credentialSteps[id]! : failureStep])),
]));
export function nextStep(id: string, state: string, reason?: string): NextStep {
  if (state === 'connected') return { text: 'no action needed' };
  if (state === 'configured') return { text: 'a Live session connects on demand' };
  if (state === 'missing' || reason === 'credential_missing') return Object.hasOwn(nextSteps, id) ? nextSteps[id]!.credential_missing! : { text: "Add the connector credential under the effective data directory; see RUNBOOK, then restart Lux Didi." };
  return Object.hasOwn(nextSteps, id) && Object.hasOwn(nextSteps[id]!, reason ?? 'unknown') ? nextSteps[id]![reason ?? 'unknown']! : failureStep;
}
