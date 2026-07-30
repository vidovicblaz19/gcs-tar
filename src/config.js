import { TarGcsError, ErrCode } from './errors.js';

/**
 * @typedef {object} TarFileSpec
 * @property {string} name   - GCS object key
 * @property {number} [size]  - File size in bytes (fetched if omitted)
 * @property {Date}   [mtime] - Modification time (defaults to now)
 */

/**
 * @typedef {object} TarGcsConfig
 * @property {string}            bucket      - GCS bucket name (required)
 * @property {(string|TarFileSpec)[]} files  - GCS object keys to include (required)
 * @property {string}            targetKey   - Destination key for the .tar file (required)
 * @property {string}            [workPrefix]- Shared work prefix (default "tmp/tar-gcs/")
 * @property {string}            [padPrefix] - Pad object prefix (derived: "tmp/tar-gcs-pad/")
 * @property {boolean}           [lowMemory] - Process files in pages (default false)
 * @property {boolean}           [validation] - Enable CRC32C validation on uploads (default true)
 */

/**
 * @typedef {object} ResolvedConfig
 * @property {string}               bucket
 * @property {(string|TarFileSpec)[]} files
 * @property {string}               targetKey
 * @property {string}               workPrefix
 * @property {string}               padPrefix
 * @property {boolean}              lowMemory
 * @property {boolean}              validation
 */

/**
 * Merge user options with defaults. Validates required fields.
 * padPrefix is derived from workPrefix by appending "-pad" unless overridden.
 *
 * @param {TarGcsConfig & { storage?: unknown }} userOpts
 * @returns {ResolvedConfig}
 * @throws {TarGcsError}
 */
export function resolveConfig(userOpts) {
  if (!userOpts || typeof userOpts !== 'object') {
    throw new TarGcsError(
      'Config must be an object with at least "bucket", "files", and "targetKey".',
      { code: ErrCode.INVALID_CONFIG },
    );
  }

  const missing = [];
  if (!userOpts.bucket) missing.push('bucket');
  if (!userOpts.targetKey) missing.push('targetKey');
  if (!Array.isArray(userOpts.files)) missing.push('files');

  if (missing.length > 0) {
    throw new TarGcsError(
      `Missing required config: ${missing.join(', ')}.`,
      { code: ErrCode.INVALID_CONFIG, detail: { missing } },
    );
  }

  if (!userOpts.storage) {
    throw new TarGcsError(
      'A GCS Storage instance is required. Pass it as `storage` in the config.',
      { code: ErrCode.INVALID_CONFIG },
    );
  }

  const workPrefix = (userOpts.workPrefix ?? 'tmp/tar-gcs/').replace(/\/?$/, '/');
  const padPrefix = (userOpts.padPrefix ?? `${workPrefix.replace(/\/$/, '')}-pad/`).replace(/\/?$/, '/');

  return {
    bucket: /** @type {string} */ (userOpts.bucket),
    targetKey: /** @type {string} */ (userOpts.targetKey),
    files: /** @type {(string|import('./config.js').TarFileSpec)[]} */ (userOpts.files),
    workPrefix,
    padPrefix,
    lowMemory: userOpts.lowMemory ?? false,
    validation: userOpts.validation ?? true,
  };
}
