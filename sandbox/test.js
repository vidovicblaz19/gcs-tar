import { Storage } from '@google-cloud/storage';
import { createTar } from 'tar-gcs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CONFIG — edit these to match your bucket and prefix
// ---------------------------------------------------------------------------
const BUCKET = process.env.TAR_GCS_BUCKET || 'project-carrot-stag.appspot.com';
const PREFIX = process.env.TAR_GCS_PREFIX || '';
const TARGET_KEY = process.env.TAR_GCS_TARGET || `tar-gcs-sandbox-${Date.now()}.tar`;

const credentialsPath = resolve(__dirname, 'project-carrot-stag-firebase.json');

// ---------------------------------------------------------------------------

async function main() {
  const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));

  const storage = new Storage({
    projectId: credentials.project_id,
    credentials,
  });

  const bucket = storage.bucket(BUCKET);

  // Show what's under the prefix (first 10 files)
  console.log(`\nListing objects under prefix "${PREFIX || '(root)'}" in bucket "${BUCKET}"...`);
  const [files] = await bucket.getFiles({ prefix: PREFIX, maxResults: 10 });
  if (files.length === 0) {
    console.log('  (no files found)');
  } else {
    for (const f of files) {
      console.log(`  ${f.name}  (${f.metadata.size} bytes)`);
    }
    if (files.length === 10) {
      console.log('  ... (showing first 10)');
    }
  }

  console.log(`\nCreating tar "${TARGET_KEY}" from prefix "${PREFIX || '(root)'}"...\n`);

  const result = await createTar({
    storage,
    bucket: BUCKET,
    prefix: PREFIX,
    targetKey: TARGET_KEY,
  });

  console.log('Done!');
  console.log('  key:    ', result.key);
  console.log('  size:   ', result.size, 'bytes');
  console.log('  crc32c: ', result.crc32c);

  // Download and verify a few bytes
  const [buf] = await bucket.file(TARGET_KEY).download();
  console.log('  downloaded size:', buf.length, 'bytes');
  console.log('  first 8 bytes (hex):', buf.subarray(0, 8).toString('hex'));

  console.log('\nCleanup: delete the tar?');
  console.log(`  gsutil rm gs://${BUCKET}/${TARGET_KEY}`);
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  if (err.errors) {
    for (const e of err.errors) console.error('  -', e.message);
  }
  process.exit(1);
});
