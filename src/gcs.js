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
 * @typedef {import('./config.js').TarFileSpec} TarFileSpec
 */

/**
 * Resolve file keys / specs into full GcsObjectInfo by fetching
 * metadata for any entries missing size or mtime.
 *
 * @param {GcsBucket} bucket
 * @param {(string|TarFileSpec)[]} entries
 * @returns {Promise<GcsObjectInfo[]>}
 */
export async function resolveFiles(bucket, entries) {
  return Promise.all(
    entries.map(async (entry) => {
      if (typeof entry === 'string') {
        return resolveOne(bucket, entry);
      }
      if (entry.size != null) {
        return {
          name: entry.name,
          size: entry.size,
          updated: entry.mtime ?? new Date(),
        };
      }
      return resolveOne(bucket, entry.name, entry.mtime);
    }),
  );
}

/**
 * @param {GcsBucket} bucket
 * @param {string} name
 * @param {Date} [fallbackMtime]
 * @returns {Promise<GcsObjectInfo>}
 */
async function resolveOne(bucket, name, fallbackMtime) {
  const [metadata] = await bucket.file(name).getMetadata();
  return {
    name,
    size: Number(metadata.size ?? 0),
    updated: metadata.updated ? new Date(metadata.updated) : (fallbackMtime ?? new Date()),
  };
}

/**
 * Resolve files page by page for low-memory mode.
 *
 * @param {GcsBucket} bucket
 * @param {(string|TarFileSpec)[]} entries
 * @param {number} [pageSize]
 * @yields {Promise<GcsObjectInfo[]>}
 */
export async function* resolveFilesPaged(bucket, entries, pageSize = 500) {
  for (let i = 0; i < entries.length; i += pageSize) {
    const page = entries.slice(i, i + pageSize);
    yield resolveFiles(bucket, page);
  }
}

/**
 * Upload a buffer as a GCS object.
 *
 * @param {GcsBucket} bucket
 * @param {string} key
 * @param {Buffer} buffer
 * @param {object} [opts]
 * @param {boolean} [opts.validation] - Enable CRC32C integrity check (default true)
 * @returns {Promise<void>}
 */
export async function uploadBuffer(bucket, key, buffer, opts) {
  const file = bucket.file(key);
  await file.save(buffer, { resumable: false, validation: opts?.validation ?? true });
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
