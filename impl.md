# Implementation Plan — tar-gcs

## Approach: Upload small tar parts, compose via GCS API

Instead of streaming, we leverage GCS's **compose API** which concatenates existing objects into a new object server-side (no data transfer). Up to 32 source objects per compose call; chainable for larger sets.

## What gets uploaded

For each file in the source bucket, two tiny objects are uploaded to a temp prefix:

| Part          | Size         | Content                                                     |
|---------------|------------- |-------------------------------------------------------------|
| Header        | 512 bytes    | Tar header block for the file                               |
| Padding       | 0–511 bytes  | Zero bytes aligning the file end to a 512-byte boundary     |
| End-of-archive| 1024 bytes   | Two zero blocks marking end-of-tar (uploaded once at the end)|

The **source file data itself is never copied** — the compose API references it in place.

## Flow

```
SOURCE BUCKET                      TEMP PREFIX (tmp/tar-gcs/)          TARGET KEY
─────────────                      ──────────────────────────          ──────────

1. List objects under prefix
   └─ file1.jpg (1.2 MB)
      file2.png (800 KB)
      dir/file3.txt (50 B)

2. For each file:
   ├─ Generate 512B tar header    →  Upload →  headers/file1.jpg
   ├─ Compute padding (pads data  →  Upload →  padding/file1.jpg
   │  to 512B boundary)               (only if padding > 0)
   └─ Record component sequence:
      [header/file1.jpg, file1.jpg, padding/file1.jpg]

3. Compose in batches (≤32 per call):
   Batch 1: compose(first 32 components)  →  parts/tmp-0001
   Batch 2: compose(next 32 components)   →  parts/tmp-0002
   ...
   Batch N: compose(...)                  →  parts/tmp-NNNN

   If >1 batch: compose all parts/ + end  →  target-key.tar
   If 1 batch:   compose all + end        →  target-key.tar

4. Cleanup temp objects (headers/, padding/, parts/)
```

## Component ordering (per single file tar entry)

```
[HEADER: 512B]  [SOURCE FILE: N bytes]  [PADDING: (512 - N%512) % 512 bytes]
     ↑                  ↑                           ↑
  uploaded          already in                   uploaded
  as object         source bucket               as object
```

## Multiple-file ordering

```
[header_f1][source_f1][pad_f1][header_f2][source_f2][pad_f2]...[header_fn][source_fn][pad_fn][ZERO × 1024]
```

## GCS compose API behavior

```js
await storage.bucket(bucket).file(destination).compose(sources)
```

- `sources` is an array of File objects or name strings (max 32)
- Source objects can be in the same or different buckets
- Destination object inherits metadata from the first source
- CRC32C is recalculated server-side for the composite
- The resulting object has size = sum of source sizes
- Chaining: compose results of previous compose calls (they're now regular objects)

## File structure

```
src/
├── tar.js        encodeHeader(), pad512(), END_BLOCKS constant
├── config.js     Defaults and helpers for bucket/temp-prefix config
├── gcs.js        GCS operations (list, metadata, upload, compose)
└── index.js      Public API: createTar(bucket, prefix, targetKey, opts)
```

## tar.js API

```js
// Creates a 512-byte tar header block from file metadata
encodeHeader({ name, size, mtime, mode, type }): Buffer

// Rounds size up to next 512-byte boundary
pad512(size): number

// Two 512-byte zero blocks (end-of-archive marker)
END_BLOCKS: Buffer   // 1024 bytes of zeros
```

## config.js API

```js
// Default config, merges with user overrides
resolveConfig(opts): {
  bucket: string,          // source bucket (required)
  tempPrefix: string,      // "tmp/tar-gcs/" default
  targetKey: string,       // destination object key
}

// Also holds GCS credentials / client initialization
```

## gcs.js API

```js
// List all objects under a prefix (handles pagination)
listObjects(bucket, prefix): Promise<ObjectMetadata[]>

// Get single object metadata (size, checksums, mtime)
getMetadata(bucket, key): Promise<{ size, crc32c, md5Hash, updated }>

// Upload a Buffer as a GCS object (for headers/padding/end)
uploadBuffer(bucket, key, buffer): Promise<void>

// Compose up to 32 source objects into one destination
compose(bucket, sources, destination): Promise<void>

// Compose arbitrary number of sources using chaining
composeAll(bucket, sources, destination): Promise<void>
```

## index.js API (public)

```js
/**
 * Create a tar file from GCS objects and write it to the same bucket.
 *
 * @param {object} opts
 * @param {string} opts.bucket        - GCS bucket name
 * @param {string} opts.prefix        - Object key prefix to include
 * @param {string} opts.targetKey     - Destination key for the .tar file
 * @param {string} [opts.tempPrefix]  - Temp working prefix (default "tmp/tar-gcs/")
 * @returns {Promise<{key: string, size: string, crc32c: string}>}
 */
export async function createTar(opts)
```

## Edge cases

- **0 files under prefix**: Create a tar with only end-of-archive blocks (valid empty tar)
- **>32 × 32 = 1024 files**: Chain compose in tree fashion: compose batches of 32 into intermediates, then compose intermediates
- **Files with `/` suffix**: Treat as directory entries (typeflag='5', size=0)
- **Long keys (>100 chars)**: Use ustar prefix field (supports up to 255 chars)
- **Large files**: GCS compose works regardless of file size; no data transfer needed
- **CRC32C integrity**: Verify composed tar matches expected CRC32C (if source checksums available)

## Dependencies

- `@google-cloud/storage` — GCS client library (or `@google-cloud/storage`)

## Open questions

1. Should we support gzip compression of the final tar? GCS can serve gzipped content with proper `Content-Encoding`. Could add a `gzip: true` option that wraps the final compose result... but GCS compose doesn't do compression. Would need a Cloud Run / Cloud Functions step to compress. **Leave for v2.**

2. Should hashes be included in an extended PAX header? GCS provides CRC32C and MD5. These could be stored as PAX attributes (e.g., `GCS.crc32c=...`). **Nice-to-have, leave for v2.**

3. What about object metadata (custom GCS metadata)? Could be stored in PAX as `GCS.metadata.key=value`. **v2.**
