import { encodeHeader, encodeLongLinkHeader, pad512 } from './tar.js';
import { resolveConfig } from './config.js';
import {
  resolveFiles,
  resolveFilesPaged,
  uploadBuffer,
  composeAll,
} from './gcs.js';
import { ensureBasePads, ensurePad } from './pad.js';

export { TarGcsError, ErrCode } from './errors.js';

/**
 * @param {number} [len]
 * @returns {string}
 */
function runToken(len = 6) {
  const rnd = Math.random().toString(36).slice(2, 2 + len);
  const ts = Date.now().toString(36).slice(-4);
  return `${rnd}${ts}`;
}

/**
 * @typedef {import('./config.js').TarGcsConfig} TarGcsConfig
 * @typedef {import('./config.js').ResolvedConfig} ResolvedConfig
 * @typedef {import('./gcs.js').GcsBucket} GcsBucket
 * @typedef {import('./gcs.js').GcsObjectInfo} GcsObjectInfo
 */

/**
 * Return metadata for a composed tar.
 *
 * @param {import('./gcs.js').GcsBucket} bucket
 * @param {string} key
 * @returns {Promise<{ key: string, size: string, crc32c: string }>}
 */
async function resultMeta(bucket, key) {
  const [metadata] = await bucket.file(key).getMetadata();
  return {
    key,
    size: String(metadata.size ?? ''),
    crc32c: metadata.crc32c ?? '',
  };
}

/**
 * @param {object} opts
 * @param {import('./gcs.js').GcsBucket} opts.bucket
 * @param {ResolvedConfig} opts.cfg
 * @param {GcsObjectInfo[]} opts.files
 * @param {string} opts.workBase
 * @returns {Promise<string[]>} compose source keys for this page
 */
async function processPage({ bucket, cfg, files, workBase }) {
  /** @type {string[]} */
  const sources = [];

  for (const f of files) {
    if (f.name.length >= 100) {
      const llHdrKey = `${workBase}headers/${f.name}.longlink`;
      const llHdr = encodeLongLinkHeader(f.name);
      await uploadBuffer(bucket, llHdrKey, llHdr, { validation: cfg.validation });
      sources.push(llHdrKey);

      const llBodyLen = pad512(f.name.length + 1);
      const llBody = Buffer.alloc(llBodyLen);
      llBody.write(f.name + '\0', 0, 'utf8');
      const llBodyKey = `${workBase}headers/${f.name}.longlink-body`;
      await uploadBuffer(bucket, llBodyKey, llBody, { validation: cfg.validation });
      sources.push(llBodyKey);
    }

    const hdrKey = `${workBase}headers/${f.name}`;
    const hdr = encodeHeader({ name: f.name, size: f.size, mtime: f.updated });
    await uploadBuffer(bucket, hdrKey, hdr, { validation: cfg.validation });
    sources.push(hdrKey);

    sources.push(f.name);

    const padLen = (pad512(f.size) - f.size) || 0;
    const padKey = await ensurePad(bucket, cfg.padPrefix, padLen);
    if (padKey) {
      sources.push(padKey);
    }
  }

  return sources;
}

/**
 * @param {import('./gcs.js').GcsBucket} bucket
 * @param {string} workBase
 * @returns {Promise<void>}
 */
async function cleanup(bucket, workBase) {
  try {
    await bucket.deleteFiles({ prefix: workBase });
  } catch {
    // best-effort — orphaned objects get cleaned by TTL
  }
}

/**
 * Create a tar archive from GCS objects using server-side compose.
 *
 * Uploads only small header parts — pads are pre-cached from
 * power-of-2 building blocks and reused across runs.
 *
 * @param {TarGcsConfig} opts
 * @returns {Promise<{ key: string, size: string, crc32c: string }>}
 *
 * @throws {TarGcsError}  on invalid config
 * @throws {AggregateError}  when compose batching fails
 * @throws GCS API errors pass through unwrapped
 */
export async function createTar(opts) {
  const cfg = resolveConfig(opts);
  const bucket = cfg.bucket;
  const token = runToken();
  const workBase = `${cfg.workPrefix}${token}/`;

  try {
    await ensureBasePads(bucket, cfg.padPrefix, { validation: cfg.validation });

    if (cfg.lowMemory) {
      return await createTarLowMem(bucket, cfg, workBase);
    }

    const files = await resolveFiles(bucket, cfg.files);

    if (files.length === 0) {
      await uploadBuffer(bucket, cfg.targetKey, Buffer.alloc(1024), { validation: cfg.validation });
      return await resultMeta(bucket, cfg.targetKey);
    }

    const composeSources = await processPage({ bucket, cfg, files, workBase });
    composeSources.push(`${cfg.padPrefix}512`);
    composeSources.push(`${cfg.padPrefix}512`);

    await composeAll(bucket, composeSources, cfg.targetKey, `${workBase}int/`);
    return await resultMeta(bucket, cfg.targetKey);
  } finally {
    await cleanup(bucket, workBase);
  }
}

/**
 * Low-memory path: process files page by page, composing each
 * page into an intermediate segment, then stitch segments together.
 *
 * @param {import('./gcs.js').GcsBucket} bucket
 * @param {ResolvedConfig} cfg
 * @param {string} workBase
 * @returns {Promise<{ key: string, size: string, crc32c: string }>}
 */
async function createTarLowMem(bucket, cfg, workBase) {
  /** @type {string[]} */
  const intermediates = [];
  let fileCount = 0;

  try {
    for await (const page of resolveFilesPaged(bucket, cfg.files)) {
      fileCount += page.length;

      const sources = await processPage({ bucket, cfg, files: page, workBase });
      const segIndex = String(intermediates.length).padStart(5, '0');
      const segKey = `${workBase}seg-${segIndex}`;
      await composeAll(bucket, sources, segKey, `${workBase}seg-int-${segIndex}/`);
      intermediates.push(segKey);
    }

    if (fileCount === 0) {
      await uploadBuffer(bucket, cfg.targetKey, Buffer.alloc(1024), { validation: cfg.validation });
      return await resultMeta(bucket, cfg.targetKey);
    }

    intermediates.push(`${cfg.padPrefix}512`);
    intermediates.push(`${cfg.padPrefix}512`);

    await composeAll(bucket, intermediates, cfg.targetKey, `${workBase}int/`);
    return await resultMeta(bucket, cfg.targetKey);
  } finally {
    await cleanup(bucket, workBase);
  }
}
