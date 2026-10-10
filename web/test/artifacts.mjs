import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// Test support only. Retain evidence; callers never own an existing supplied root.
export async function createArtifactDir(proofDirectory, artifactRoot = process.env.DIDI_ARTIFACT_DIR) {
  if (artifactRoot !== undefined && (!artifactRoot || !isAbsolute(artifactRoot) || artifactRoot.includes('\0'))) {
    throw new Error('DIDI_ARTIFACT_DIR must be a nonempty absolute directory path');
  }
  try {
    if (artifactRoot !== undefined) await mkdir(artifactRoot, { recursive: true });
    // A fresh run even with an explicit root prevents same-SHA screenshot overwrite.
    const runRoot = await mkdtemp(join(artifactRoot ?? tmpdir(), 'didi-proof-'));
    const images = join(runRoot, proofDirectory);
    await mkdir(images, { recursive: true });
    console.log(`DIDI artifacts run=${runRoot} images=${images}`);
    return images;
  } catch (cause) {
    throw new Error(`Cannot create browser artifacts under ${artifactRoot === undefined ? 'the temporary directory' : 'DIDI_ARTIFACT_DIR'}: ${cause.message}`, { cause });
  }
}
