import assert from 'node:assert/strict';

export function commentaryPart(text: string): Record<string, any> {
  assert.ok(text.length <= 450, 'encoded commentary fits the real transport');
  assert.match(text, /^```COMMENTARY\n[^\n]+\n```$/u);
  return JSON.parse(text.slice(14, -4));
}

/** Assert the complete wire sequence before projecting its content for domain tests. */
export function commentaryResults<T extends { text: string }>(items: T[]): (T & { kind: string; exact: string[]; parts: number })[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const part = commentaryPart(item.text);
    const group = groups.get(part.id) ?? [];
    const prior = group.find(value => commentaryPart(value.text).part === part.part);
    if (prior) {
      assert.equal(item.text, prior.text, 'retries preserve the identical wire item');
      group[group.indexOf(prior)] = item; // Latest transport command owns acceptance on a rebuilt session.
    }
    else group.push(item);
    groups.set(part.id, group);
  }
  return [...groups.values()].map(group => {
    const parts = group.map(item => commentaryPart(item.text));
    const head = parts[0]!;
    assert.equal(head.section, 'header');
    for (const [i, part] of parts.entries()) {
      assert.equal(part.part, `${i + 1}/${parts.length}`);
      assert.equal(part.final, i === parts.length - 1);
    }
    return { ...group.at(-1)!, kind: head.kind, exact: parts.flatMap(part => part.exact ?? []), parts: parts.length,
      text: parts.filter(part => part.section === 'content').map(part => part.content).join(' ') };
  });
}
