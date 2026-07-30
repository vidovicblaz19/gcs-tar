/**
 * @typedef {import('@google-cloud/storage').Storage} GcsStorage
 * @typedef {import('@google-cloud/storage').Bucket} GcsBucket
 */

/**
 * @typedef {object} GcsObjectInfo
 * @property {string} name
 * @property {number} size
 * @property {string} [crc32c]
 * @property {string} [md5Hash]
 * @property {Date}   updated
 * @property {string} [contentType]
 */

/**
 * List all objects under a prefix. Handles pagination.
 *
 * @param {GcsBucket} bucket
 * @param {string} prefix
 * @returns {Promise<GcsObjectInfo[]>}
 */
export async function listObjects(bucket, prefix) {
  const [files] = await bucket.getFiles({
    prefix,
    autoPaginate: true,
    maxResults: 1000,
  });

  return files.map((f) => ({
    name: f.name,
    size: Number(f.metadata.size ?? 0),
    crc32c: f.metadata.crc32c,
    md5Hash: f.metadata.md5Hash,
    updated: new Date(f.metadata.updated ?? Date.now()),
    contentType: f.metadata.contentType ?? undefined,
  }));
}

/**
 * List objects page by page. Yields each page as an array.
 * Use when total object count could exceed available memory.
 *
 * @param {GcsBucket} bucket
 * @param {string} prefix
 * @param {number} [pageSize]
 * @yields {Promise<GcsObjectInfo[]>}
 */
export async function* listObjectsPaged(bucket, prefix, pageSize = 500) {
  /** @type {string | undefined} */
  let pageToken;

  do {
    /** @type {import('@google-cloud/storage').GetFilesOptions} */
    const opts = {
      prefix,
      maxResults: pageSize,
      autoPaginate: false,
    };
    if (pageToken) opts.pageToken = pageToken;

    const [files, query] = await bucket.getFiles(opts);
    pageToken = /** @type {string | undefined} */ (query?.pageToken);

    yield files.map((f) => ({
      name: f.name,
      size: Number(f.metadata.size ?? 0),
      crc32c: f.metadata.crc32c,
      md5Hash: f.metadata.md5Hash,
      updated: new Date(f.metadata.updated ?? Date.now()),
      contentType: f.metadata.contentType ?? undefined,
    }));
  } while (pageToken);
}

/**
 * Upload a buffer as a GCS object.
 *
 * @param {GcsBucket} bucket
 * @param {string} key
 * @param {Buffer} buffer
 * @returns {Promise<void>}
 */
export async function uploadBuffer(bucket, key, buffer) {
  const file = bucket.file(key);
  await file.save(buffer, { resumable: false });
}

/**
 * Compose an arbitrary number of source objects using a parallel
 * merge tree.  Sources are split into batches of ≤32, all batches
 * at a level are composed in parallel, and the process repeats until
 * a single destination object remains.
 *
 * On batch failure at any level, successfully-created intermediates
 * at that level are cleaned and an AggregateError is thrown with
 * each underlying error preserved.
 *
 * GCS API errors (permission, network, etc.) pass through unwrapped
 * in the single-batch (≤32) case.
 *
 * @param {GcsBucket} bucket
 * @param {string[]} sources - array of object keys (any length)
 * @param {string} destination - final composite object key
 * @param {string} intBase - prefix for intermediate compose objects
 * @returns {Promise<void>}
 */
export async function composeAll(bucket, sources, destination, intBase) {
  if (sources.length === 0) return;

  if (sources.length <= 32) {
    await bucket.combine(sources, destination);
    return;
  }

  let level = 0;
  let current = sources;
  /** @type {string[]} */
  const cleanPrefixes = [];

  while (current.length > 32) {
    const intPrefix = `${intBase}l${level}/`;
    cleanPrefixes.push(intPrefix);

    const batches = splitBatches(current, 32);
    const results = await Promise.allSettled(
      batches.map((batch, i) => {
        const key = `${intPrefix}${String(i).padStart(5, '0')}`;
        return bucket.combine(batch, key).then(() => key);
      }),
    );

    /** @type {string[]} */
    const succeeded = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        succeeded.push(r.value);
      }
    }

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      await Promise.allSettled(
        cleanPrefixes.map((pfx) => bucket.deleteFiles({ prefix: pfx })),
      );

      const errors = failed.map((r) => /** @type {PromiseRejectedResult} */ (r).reason);
      const msg = `${failed.length} of ${batches.length} compose batches failed at merge level ${level}.`;
      throw new AggregateError(errors, msg);
    }

    current = succeeded;
    level++;
  }

  await bucket.combine(current, destination);

  await Promise.allSettled(
    cleanPrefixes.map((pfx) => bucket.deleteFiles({ prefix: pfx })),
  );
}

/**
 * @template T
 * @param {T[]} arr
 * @param {number} size
 * @returns {T[][]}
 */
function splitBatches(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
