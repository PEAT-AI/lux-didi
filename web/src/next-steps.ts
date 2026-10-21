// Fixed instructions only, never provider payloads or credential contents.
export const connectorIDs = ["lux-knowledge", "gmail", "calendar", "mattermost", "mongoose"] as const;
export const reasonCodes = ["credential_missing", "needs_sign_in", "unreachable", "discovery_failed", "handshake_failed", "unknown"] as const;
export interface NextStep { text: string; guideUrl?: string; command?: string }
/** One sign-in row: the Settings button does the work, so this carries no command. */
const signInStep: NextStep = { text: "Sign in to Mongoose in Settings: the Sign in button is on the Mongoose row, and the connector reconnects by itself when you finish.", guideUrl: "https://github.com/PEAT-AI/lux-didi/blob/main/docs/user-guide.md#connector-setup" };
const credentialSteps: Record<string, NextStep> = {
  "lux-knowledge": { text: "Configure this connector and its credentials in your explicitly selected protected configuration directory. Use the Setup guide, then restart Lux Didi.", guideUrl: "https://github.com/PEAT-AI/lux-didi/blob/main/docs/user-guide.md#connector-setup" },
  "gmail": { text: "Configure this connector and its credentials in your explicitly selected protected configuration directory. Use the Setup guide, then restart Lux Didi.", guideUrl: "https://github.com/PEAT-AI/lux-didi/blob/main/docs/user-guide.md#connector-setup" },
  "calendar": { text: "Configure this connector and its credentials in your explicitly selected protected configuration directory. Use the Setup guide, then restart Lux Didi.", guideUrl: "https://github.com/PEAT-AI/lux-didi/blob/main/docs/user-guide.md#connector-setup" },
  "mattermost": { text: "Configure this connector and its credentials in your explicitly selected protected configuration directory. Use the Setup guide, then restart Lux Didi.", guideUrl: "https://github.com/PEAT-AI/lux-didi/blob/main/docs/user-guide.md#connector-setup" },
  "mongoose": { text: "Mongoose session expired, reconnect Mongoose: sign in once in your browser, then restart Lux Didi.", command: "mongoose-login", guideUrl: "https://github.com/PEAT-AI/lux-didi/blob/main/docs/user-guide.md#connector-setup" },
};
const failureStep: NextStep = { text: "Check the connector service, then use Copy diagnostics from the Lux Didi menu." };
export const nextSteps: Record<string, Record<string, NextStep>> = Object.fromEntries(connectorIDs.map(id => [
  id, Object.fromEntries(reasonCodes.map(reason => [reason, reason === 'needs_sign_in' ? signInStep : reason === 'credential_missing' ? credentialSteps[id]! : failureStep])),
]));
export function nextStep(id: string, state: string, reason?: string): NextStep {
  if (state === 'connected') return { text: 'no action needed' };
  if (state === 'configured') return { text: 'a Live session connects on demand' };
  if (state === 'missing' || reason === 'credential_missing') return Object.hasOwn(nextSteps, id) ? nextSteps[id]!.credential_missing! : { text: "Configure this connector and its credentials in your explicitly selected protected configuration directory. Use the Setup guide, then restart Lux Didi.", guideUrl: "https://github.com/PEAT-AI/lux-didi/blob/main/docs/user-guide.md#connector-setup" };
  return Object.hasOwn(nextSteps, id) && Object.hasOwn(nextSteps[id]!, reason ?? 'unknown') ? nextSteps[id]![reason ?? 'unknown']! : failureStep;
}
