/**
 * Base error for gcs-tar internal failures (config, orchestration).
 * GCS API errors pass through unwrapped — the consumer owns the
 * @google-cloud/storage dependency and handles its errors directly.
 *
 * @extends Error
 */
export class TarGcsError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.code]
   * @param {Record<string, unknown>} [opts.detail]
   */
  constructor(message, opts) {
    super(message);
    this.name = 'TarGcsError';
    /** @type {string} */
    this.code = (opts && opts.code) || 'ERR_UNKNOWN';
    /** @type {Record<string, unknown>} */
    this.detail = (opts && opts.detail) || {};
  }
}

/** @enum {string} */
export const ErrCode = {
  INVALID_CONFIG: 'ERR_INVALID_CONFIG',
  COMPOSE_ALL: 'ERR_COMPOSE_ALL',
};
