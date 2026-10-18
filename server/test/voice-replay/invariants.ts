import type { CallObligation, Command, Projection, Receipt, Replay } from './driver.js';

/**
 * The six invariants every scenario asserts, computed from what the driver observed. Each returns a plain
 * sentence, so a failing scenario quotes the invariant it broke rather than an assertion line number.
 */
export interface Violations { readonly list: readonly string[] }

const ANSWER_COMMANDS = new Set(['response.item.create', 'response.create']);

export function analyse(input: {
  readonly calls: readonly CallObligation[];
  readonly batches: readonly { readonly epoch: number; readonly at: number; readonly callIds: readonly string[]; readonly create: Command | undefined }[];
  readonly commands: readonly Command[];
  readonly projections: readonly Projection[];
  readonly receipts: readonly Receipt[];
  readonly dispositions: readonly { readonly at: number; readonly callId: string; readonly code: string }[];
  readonly deadlineMs: number;
  /** A scenario that ends a call before its answer is expected says so here, and only here. */
  readonly allowUnanswered?: boolean;
}): Violations {
  const list: string[] = [];
  const { calls, commands, projections, receipts, deadlineMs } = input;
  const terminalAt = projections.find(entry => entry.lifecycle === 'terminal')?.at;

  // 1. one local terminal disposition and one output submission per observed call, in the epoch that owes it.
  //    A re-submission after a reconnect is a different generation resuming a lost call, not a repeat.
  for (const call of calls) {
    const outputs = commands.filter(command => command.type === 'response.item.create' && command.epoch === call.epoch
      && (command.frame['item'] as Record<string, unknown> | undefined)?.['call_id'] === call.callId);
    const lost = input.dispositions.find(entry => entry.callId === call.callId);
    if (outputs.length === 0 && lost) continue;
    if (outputs.length === 0) {
      if (!input.allowUnanswered) list.push(`invariant 1: call ${call.callId} (${call.name}) got no output submission and no typed disposition`);
    } else if (outputs.length > 1) {
      list.push(`invariant 1: call ${call.callId} (${call.name}) got ${outputs.length} output submissions, not one`);
    }
  }

  // 2. every ready batch gets exactly one continuation decision: one `response.create` immediately after the
  //    batch's results, never a second one for the same results, and never a withheld one.
  for (const batch of input.batches) {
    if (batch.create === undefined) {
      list.push(`invariant 2: the batch ${batch.callIds.join(',')} submitted its results and no continuation followed`);
      continue;
    }
    // A continuation waits for every pending call of the delegation it answers: a create after a partial batch
    // is the "do not resend it" the delegation guide forbids.
    const decidedAt = batch.create.at;
    const answered = new Set(input.batches.flatMap(entry => entry.create !== undefined && entry.create.at <= decidedAt ? entry.callIds : []));
    const answeredNow = new Set([...answered, ...batch.callIds]);
    for (const callId of batch.callIds) {
      const call = calls.find(entry => entry.callId === callId);
      if (!call) continue;
      const pending = calls.filter(entry => entry.delegationId === call.delegationId && entry.epoch === call.epoch);
      const missing = pending.filter(entry => !answeredNow.has(entry.callId)).map(entry => entry.callId);
      if (missing.length > 0) {
        list.push(`invariant 2: a continuation was sent for ${callId} while ${missing.join(',')} of delegation ${call.delegationId} had no result`);
      }
    }
  }
  const decided = new Set(input.batches.map(batch => batch.create?.seq).filter((seq): seq is number => seq !== undefined));
  if (decided.size !== input.batches.filter(batch => batch.create !== undefined).length) {
    list.push('invariant 2: one continuation decision covers more than one ready batch');
  }

  // 3. no stale-epoch write: once the session settled, nothing may be written for it but a close.
  for (const command of commands) {
    if (terminalAt !== undefined && command.at > terminalAt && ANSWER_COMMANDS.has(command.type)) {
      list.push(`invariant 3: ${command.type} was written at ${command.at - terminalAt} ms after the session settled`);
    }
  }

  // 4. no uncertain action is repeated: one output per call id ever, and no tool retried after a disposition.
  const seen = new Set<string>();
  for (const command of commands) {
    if (command.type !== 'response.item.create') continue;
    const item = command.frame['item'] as Record<string, unknown> | undefined;
    if (item?.['type'] !== 'function_call_output') continue;
    const id = `${command.epoch}:${String(item['call_id'])}`;
    if (seen.has(id)) list.push(`invariant 4: the action for ${id} was submitted twice in one generation`);
    seen.add(id);
  }

  // 5. pending work never disappears because audio went quiet: while a call is unanswered the projection may
  //    not read listening, which is what an audible-silence rule produces.
  for (const projection of projections) {
    const outstanding = calls.filter(call => call.at <= projection.at && call.outputs.length === 0
      && !input.dispositions.some(entry => entry.callId === call.callId && entry.at <= projection.at)
      && (terminalAt === undefined || projection.at < terminalAt));
    if (outstanding.length > 0 && projection.state === 'listening') {
      list.push(`invariant 5: the orb read listening at ${projection.at} with ${outstanding.map(call => call.callId).join(',')} unanswered (${projection.cause})`);
      break;
    }
  }

  // 6. every turn that requires an answer ends in first audible output or a typed failure in its deadline.
  for (const call of calls) {
    if (call.outputs.length !== 1) continue;
    const owedAt = call.outputs[0]!.at;
    const delivered = receipts.find(receipt => receipt.at >= owedAt);
    const settled = projections.find(entry => entry.at >= owedAt && entry.lifecycle === 'terminal');
    if (delivered === undefined && settled === undefined) {
      list.push(`invariant 6: ${call.callId} was answered but the turn never became audible and never failed within the ${deadlineMs} ms deadline`);
    } else if (delivered !== undefined && delivered.at - owedAt > deadlineMs) {
      list.push(`invariant 6: ${call.callId} became audible ${delivered.at - owedAt} ms after submission, past the ${deadlineMs} ms deadline`);
    }
  }
  return { list };
}

/** The compact facts a failing scenario prints: command types in order, orb states, receipts, calls. */
export function trace(input: Replay): string {
  const commands = input.commands.map(command => {
    const item = command.frame['item'] as Record<string, unknown> | undefined;
    const callId = item?.['type'] === 'function_call_output' ? `(${String(item['call_id'])})` : '';
    return `g${command.epoch}:${command.type}${callId}`;
  }).join(' -> ');
  const orb = input.projections.map(entry => `${entry.state}@${entry.at - input.clock.startedAt}`).join(' ');
  const calls = input.calls.map(call => `${call.callId}:${call.outputs.length}/${call.continuation ? 'continued' : 'open'}`).join(' ');
  const outcome = input.owner.get(input.liveSessionId).terminal?.state ?? 'open';
  const fill = `${input.inaudibleFrames} fill frames`;
  return `\ncommands: ${commands}\norb: ${orb}\ncalls: ${calls}\nreceipts: ${input.receipts.length} (${fill})\ndisposition: ${outcome}`;
}
