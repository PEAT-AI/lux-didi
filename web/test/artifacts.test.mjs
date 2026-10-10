import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createArtifactDir } from './artifacts.mjs';

const proofs = ['connected/screenshots', 'native-conversation-service/screenshots', 'memory-selection-ui/screenshots'];

function assertUnder(root, destination) {
  const path = relative(root, destination);
  assert.ok(path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`), destination);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'didi-artifacts-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('supplied root retains existing data and isolates every proof and same-SHA rerun', async t => {
  const root = await fixture(t);
  const existing = join(root, 'existing.txt');
  await writeFile(existing, 'caller-owned evidence');
  const directories = [];
  for (const proof of [...proofs, proofs[0]]) {
    const images = await createArtifactDir(proof, root);
    assert.ok(isAbsolute(images));
    assert.ok(images.endsWith(`${sep}${proof.split('/').join(sep)}`));
    assertUnder(root, images);
    assertUnder(root, join(images, 'desktop-0123456789abcdef.png'));
    await writeFile(join(images, 'writable.txt'), 'filesystem fixture, not a screenshot');
    directories.push(images);
  }
  assert.equal(new Set(directories).size, directories.length);
  assert.equal(await readFile(existing, 'utf8'), 'caller-owned evidence');
  for (const images of directories) assert.equal(await readFile(join(images, 'writable.txt'), 'utf8'), 'filesystem fixture, not a screenshot');
});

test('environment selects an absolute root, including a root that does not yet exist', async t => {
  const parent = await fixture(t);
  const root = join(parent, 'new-root');
  const previous = process.env.DIDI_ARTIFACT_DIR;
  process.env.DIDI_ARTIFACT_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.DIDI_ARTIFACT_DIR; else process.env.DIDI_ARTIFACT_DIR = previous; });
  const images = await createArtifactDir(proofs[0]);
  assertUnder(root, images);
  await writeFile(join(images, 'writable.txt'), 'created');
});

test('absent input creates separate temporary run roots and preserves prior output', async t => {
  const previous = process.env.DIDI_ARTIFACT_DIR;
  delete process.env.DIDI_ARTIFACT_DIR;
  t.after(() => { if (previous !== undefined) process.env.DIDI_ARTIFACT_DIR = previous; });
  const directories = [];
  for (let run = 0; run < 2; run++) {
    const images = await createArtifactDir(proofs[0]);
    const runRoot = dirname(dirname(images));
    t.after(() => rm(runRoot, { recursive: true, force: true }));
    assertUnder(tmpdir(), images);
    await writeFile(join(images, 'writable.txt'), `run ${run}`);
    directories.push(images);
  }
  assert.notEqual(dirname(dirname(directories[0])), dirname(dirname(directories[1])));
  assert.equal(await readFile(join(directories[0], 'writable.txt'), 'utf8'), 'run 0');
});

test('malformed caller roots fail loudly instead of falling back to temporary output', async () => {
  for (const root of ['', 'relative/output', '   ', '/invalid\0root']) {
    await assert.rejects(createArtifactDir(proofs[0], root), /DIDI_ARTIFACT_DIR/);
  }
});

test('a file or unwritable directory used as the caller root fails loudly', async t => {
  const parent = await fixture(t);
  const file = join(parent, 'not-a-directory');
  await writeFile(file, 'retain me');
  await assert.rejects(createArtifactDir(proofs[0], file), /DIDI_ARTIFACT_DIR/);
  assert.equal(await readFile(file, 'utf8'), 'retain me');
  const unwritable = await mkdtemp(join(parent, 'unwritable-'));
  await chmod(unwritable, 0o500);
  try {
    await assert.rejects(createArtifactDir(proofs[0], unwritable), /DIDI_ARTIFACT_DIR/);
  } finally {
    await chmod(unwritable, 0o700);
  }
});
