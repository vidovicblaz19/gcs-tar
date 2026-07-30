import { Storage } from '@google-cloud/storage';

// fake-gcs-server creates this bucket automatically
const BUCKET = 'test-bucket';

const storage = new Storage({
  apiEndpoint: 'http://localhost:4443',
  projectId: 'test-project',
});

/**
 * @param {string} name
 * @param {string | Buffer} content
 */
export async function upload(name, content) {
  const file = storage.bucket(BUCKET).file(name);
  await file.save(typeof content === 'string' ? Buffer.from(content) : content, {
    resumable: false,
    validation: false,
  });
}

/**
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
export function unpad512(buffer) {
  // tar entries are padded to 512B boundaries; the trailing zeros in
  // the last block come from the end-of-archive marker, not from
  // file padding.  We just return the raw buffer for size checks.
  return buffer;
}

export { storage, BUCKET };
