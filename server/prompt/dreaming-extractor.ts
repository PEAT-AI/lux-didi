/**
 * The dreaming extractor's system prompt (M9, #914).
 *
 * The pass reads one finished owner call and asks for typed memory operations with turn provenance;
 * `server/services/dreaming.ts` validates every operation against the session before anything is
 * written. The prompt states the six rules the validator and the store rely on.
 */
export const DREAMING_PROMPT_VERSION = 'dreaming-extractor-v1';

export function dreamingExtractorPrompt(assistantName: string): string {
  return `You read one finished phone call between the owner and ${assistantName} and turn what survives
into typed memory items. Output JSON only: {"operations": [...]} where every element is one of

  {"op":"add","kind":"...","text":"...","subject":"...","salience":0,"event_text":null,"event_at":null,
   "place":null,"valid_until":null,"turn_start_id":3,"turn_end_id":3}
  {"op":"supersede","old_id":"...","kind":"...","text":"...","subject":"...","salience":0,
   "turn_start_id":7,"turn_end_id":7}
  {"op":"invalidate","id":"...","reason":"...","turn_start_id":9,"turn_end_id":9}
  {"op":"noop","reason":"..."}

kind is one of durable_fact, preference, person_role, transient_state, plan, promise, open_question,
correction, decision. subject is a short grouping key such as trip:phuket. text is one self-contained
sentence: third person for him ("He"), first person for her own promises ("I"). salience is 3 when he
said it matters, asked to keep it, or it carries clear personal weight such as a plan with people he
cares about, his health or a decision; 1 or 2 for the rest; 0 for anything incidental. Salience is
evidence from what was said, never a guess about his mood. turn_start_id and turn_end_id must be ids
from the call transcript below.

Rules, all of them mandatory:
1. Only items the transcript supports. If he did not say it and she did not commit to it, it is not memory.
2. Never turn her words into his facts, and never state that he did or decided something she only offered.
3. Keep his relative phrase in event_text ("next Friday") and resolve it against the call's own clock into
   event_at; a date-only phrase stays date-only. Never infer that something happened because its date passed.
4. Never store his tone, his mood, the length of his answers or his style, and never a rule about how she
   should speak, sound or be brief. This prohibition is absolute.
5. A new fact that changes an earlier derived one is a supersede naming the old id; a fact he corrects
   about himself is a correction item, and the old id may only be superseded by citing that turn.
6. Say nothing rather than guess: when the call carries no durable memory, return {"operations":[]}.`;
}
