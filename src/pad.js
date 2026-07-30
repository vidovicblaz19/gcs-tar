import { PAD_SIZES, decomposeBits } from './tar.js';
import { uploadBuffer } from './gcs.js';

/**
 * @typedef {import('@google-cloud/storage').Bucket} GcsBucket
 */

/**
 * Ensure base power-of-2 pad objects exist under padPrefix.
 * Skips any that already exist.
 *
 * @param {GcsBucket} bucket
 * @param {string} padPrefix - e.g., "tmp/tar-gcs-pad/"
 * @param {object} [opts]
 * @param {boolean} [opts.validation] - Enable CRC32C integrity check on uploads
 * @returns {Promise<void>}
 */
export async function ensureBasePads(bucket, padPrefix, opts) {
  const [existing] = await bucket.getFiles({
    prefix: padPrefix,
    autoPaginate: true,
  });
  const existingNames = new Set(existing.map((f) => f.name));

  for (const sz of PAD_SIZES) {
    const key = `${padPrefix}${sz}`;
    if (!existingNames.has(key)) {
      await uploadBuffer(bucket, key, Buffer.alloc(sz), opts);
    }
  }
}

/**
 * Get the pad-sz key for a given pad length. Creates the combined
 * pad object from power-of-2 building blocks if it doesn't exist yet.
 *
 * Returns an empty string if size is 0 (no padding needed).
 *
 * @param {GcsBucket} bucket
 * @param {string} padPrefix - e.g., "tmp/tar-gcs-pad/"
 * @param {number} size - padding size (0–511)
 * @returns {Promise<string>} - object key of the pad, or "" if size 0
 */
export async function ensurePad(bucket, padPrefix, size) {
  if (size === 0) return '';

  const padKey = `${padPrefix}sz/${size}`;

  const [exists] = await bucket.file(padKey).exists();
  if (exists) return padKey;

  const bits = decomposeBits(size);
  const srcKeys = bits.map((b) => `${padPrefix}${b}`);
  await bucket.combine(srcKeys, padKey);

  return padKey;
}
