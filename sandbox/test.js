import { Storage } from '@google-cloud/storage';
import { createTar } from 'gcs-tar';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CONFIG — edit these to match your bucket and the files you want to tar
// ---------------------------------------------------------------------------
const BUCKET = process.env.TAR_GCS_BUCKET || 'project-carrot-stag.firebasestorage.app';
const TARGET_KEY = process.env.TAR_GCS_TARGET || `gcs-tar-sandbox-${Date.now()}.tar`;

// List exact GCS object keys to include — any paths, any prefixes, no grouping required
const FILES = [
  // 'path/to/file1.jpg',
  // 'another/prefix/doc.pdf',
  // 'completely/different/place/data.csv',
];

const credentialsPath = resolve(__dirname, 'project-carrot-stag-firebase.json');

// ---------------------------------------------------------------------------

async function main() {
  if (FILES.length === 0) {
    console.error('No files configured. Edit sandbox/test.js and add keys to the FILES array.');
    process.exit(1);
  }

  const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));

  const storage = new Storage({
    projectId: credentials.project_id,
    credentials,
  });

  const bucket = storage.bucket(BUCKET);

  console.log(`\nCreating tar "${TARGET_KEY}" from ${FILES.length} file(s) in bucket "${BUCKET}"...`);
  for (const f of FILES) console.log(`  ${f}`);
  console.log();

  const result = await createTar({
    bucket,
    files: FILES,
    targetKey: TARGET_KEY,
  });

  console.log('Done!');
  console.log('  key:    ', result.key);
  console.log('  size:   ', result.size, 'bytes');
  console.log('  crc32c: ', result.crc32c);

  console.log('\nDelete the tar when done:');
  console.log(`  gsutil rm gs://${BUCKET}/${TARGET_KEY}`);
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  if (err.errors) {
    for (const e of err.errors) console.error('  -', e.message);
  }
  process.exit(1);
});
