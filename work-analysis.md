# Tar header generation for S3-compatible storage — Analysis

## Decision: Do it yourself (with minimal vendoring from node-tar)

Use the `tar` npm package is **not a good fit** for this use case. The core format is simple enough to implement directly.

---

## The Tar Format (Minimal)

A tar file is a sequence of **512-byte blocks**:

```
[512-byte header for file 1]
[file 1 data, padded to 512-byte boundary]
[512-byte header for file 2]
[file 2 data, padded to 512-byte boundary]
...
[512-byte zero block]
[512-byte zero block]   ← end-of-archive marker
```

Each header is a fixed 512-byte structure:

| Offset | Size | Field    | Description                        |
|--------|------|----------|------------------------------------|
| 0      | 100  | name     | File path (null-terminated)        |
| 100    | 8    | mode     | Permissions (octal ASCII)          |
| 108    | 8    | uid      | Owner user ID (octal ASCII)        |
| 116    | 8    | gid      | Owner group ID (octal ASCII)       |
| 124    | 12   | size     | File size in bytes (octal ASCII)   |
| 136    | 12   | mtime    | Modification time (octal unix ts)  |
| 148    | 8    | chksum   | Header checksum (octal ASCII)      |
| 156    | 1    | typeflag | Type: '0'=file, '5'=directory      |
| 157    | 100  | linkname | Target for symlinks                |
| 257    | 6    | magic    | "ustar\0"                          |
| 263    | 2    | version  | "00"                               |
| 265    | 32   | uname    | Owner user name                    |
| 297    | 32   | gname    | Owner group name                   |
| 329    | 8    | devmajor | Major device number                |
| 337    | 8    | devminor | Minor device number                |
| 345    | 155  | prefix   | Path prefix (for paths >100 chars) |

All numeric fields are **null-terminated octal ASCII strings**. This is the entire format for basic usage.

---

## Why NOT use the `tar` npm package

### 1. The package is filesystem-first, not S3-first

The `tar` package is built around `fs` operations (`fs.stat`, `fs.read`, `fs.readdir`, etc.). Its high-level API (`tar.create`, `tar.Pack`) expects local file paths and walks directories with `fs` calls.

### 2. Header generation IS exposed, but overkill as a dependency

`tar.Header` is fully exported (`src/header.ts` is `export *`'d in the index). You can create headers manually:

```js
import { Header } from 'tar'

const h = new Header({
  path: 'photos/cat.jpg',
  size: 1234567,
  mode: 0o644,
  mtime: new Date('2025-01-15T10:30:00Z'),
})
h.encode()  // fills h.block (512-byte Buffer), sets h.needPax
```

But the `Header.encode()` method alone is ~120 lines of code that does octal string padding and buffer writes. You'd be pulling in 818 commits of history, 5 dependencies (minipass, minizlib, etc.), and a whole stream-based pipeline just to generate 512-byte buffers.

### 3. You'd fight the API

The high-level API (`tar.create`) only accepts local filesystem paths. The low-level `Pack` stream calls `fs.stat`/`fs.read` internally. To stream S3 objects through it, you'd need to monkey-patch or implement cache Maps (`statCache`, `readdirCache`) — fighting the design.

`WriteEntry.Tar` wraps a `ReadEntry` — you'd need to construct fake entry objects mimicking filesystem metadata.

### 4. The `Header` class has ~150 lines of core logic

The actual header *encoding* logic (what you need) is contained in:
- `encNumber()` — writes octal numbers to buffer
- `encString()` — writes strings to buffer
- `encDate()` — writes dates as unix timestamps
- `encode()` — assembles the 512-byte block
- `splitPrefix()` — splits long paths into prefix+name

This is re-implementable in ~60 lines of focused code.

---

## Why do it yourself

### 1. Single responsibility: header generator + S3 streamer

Your package **is not a general-purpose tar library**. It does one thing: stream S3 objects into tar archives. A 60-line header generator coupled with an S3 download stream is the right tool for the job.

### 2. Zero bloat, zero dependency conflicts

- `tar` pulls in `minipass`, `minizlib`, `mkdirp`, `yallist`, `chownr` — 5 dependencies, some with native bindings
- Your package only needs an S3 client SDK (`@aws-sdk/client-s3` or `@aws-sdk/lib-storage`)
- No risk of transitive dependency conflicts with user projects

### 3. Full control over the streaming pipeline

You control exactly how S3 `GetObject` response streams are piped into the tar output:
```js
// Conceptual pipeline:
s3.send(new GetObjectCommand({ Bucket, Key }))
   .then(response => {
     const header = encodeHeader({ name: Key, size: response.ContentLength, mtime: response.LastModified })
     output.write(header)
     response.Body.pipe(output, { end: false })
   })
```

The `tar` package's `Pack` stream would fight you at every step because it wants to `fs.stat` and `fs.createReadStream` by itself.

### 4. PAX extended headers are optional

For paths > 100 chars, sizes > 8 GiB (octal `0o77777777777`), or files > 8 GiB, you need ustar prefix or PAX extended headers. The `tar` package handles these automatically, but:

- S3 object keys are typically ≤ 1024 chars (AWS limit). The ustar prefix field gives you 155+100 = 255 chars. **This is sufficient for most S3 use cases without PAX.**
- PAX headers are just another tar entry with `typeflag='x'` that precedes the file entry and contains `key=value\n` lines. Implementing PAX for edge cases is straightforward if ever needed.

---

## Technical design sketch

### Core: `encodeHeader(entry) → Buffer`

```js
/**
 * @param {object} entry
 * @param {string} entry.name     - file path in archive
 * @param {number} entry.size     - file size in bytes
 * @param {number} [entry.mode]   - unix permissions (default 0o644)
 * @param {Date}   [entry.mtime]  - mod time (default now)
 * @param {number} [entry.uid]    - owner uid (default 0)
 * @param {number} [entry.gid]    - owner gid (default 0)
 * @param {string} [entry.uname]  - owner name (default "")
 * @param {string} [entry.gname]  - group name (default "")
 * @param {string} [entry.type]   - '0'=file, '5'=dir (default '0')
 * @returns {Buffer} 512-byte tar header block
 */
export function encodeHeader(entry) { ... }
```

### Core: Padding helper

```js
/**
 * @param {number} size
 * @returns {number} size rounded up to next 512-byte boundary
 */
export function pad512(size) {
  return (size + 511) & ~511
}
```

### Streaming: `s3TarStream(bucket, prefix, s3Client) → ReadableStream`

Iterates S3 `ListObjectsV2` pages, for each object:
1. Generate a tar header from object metadata (key, size, lastModified)
2. Write header to output
3. Pipe `GetObject` response body to output
4. Write zero-padding to next 512-byte boundary
5. After last object, write two 512-byte zero blocks

### End-of-archive

```js
export const END_BLOCKS = Buffer.alloc(1024) // two 512-byte zero blocks
```

---

## S3 connector packages

A separate concern. The tar header generation should be **provider-agnostic**. The S3 connectors table:

| Provider    | SDK                                            | ESM? |
|-------------|------------------------------------------------|------|
| AWS S3      | `@aws-sdk/client-s3`                           | Yes  |
| Backblaze   | `@aws-sdk/client-s3` (S3-compatible endpoint)  | Yes  |
| Cloudflare R2| `@aws-sdk/client-s3` (S3-compatible endpoint) | Yes  |
| MinIO       | `@aws-sdk/client-s3` (S3-compatible endpoint)  | Yes  |

All four use the **same** `@aws-sdk/client-s3` package — just configure the `endpoint` and `forcePathStyle` options. This means one dependency covers all providers.

```js
import { S3Client } from '@aws-sdk/client-s3'

const backblaze = new S3Client({
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
  region: 'us-west-004',
  credentials: { accessKeyId: '...', secretAccessKey: '...' },
})
```

---

## Summary

| Factor              | Use `tar` package       | Do it yourself    |
|---------------------|-------------------------|--------------------|
| Header generation   | `tar.Header.encode()`   | ~60 lines of code  |
| Dependencies        | 5 (minipass, etc.)      | 0 (or 1 for S3)    |
| S3 streaming fit    | Poor (fs-oriented API)  | Natural fit        |
| PAX extensions      | Automatic               | Optional, add later|
| Code to maintain    | 0 lines                 | ~60 lines          |
| Bundle size impact  | ~150 KB                 | ~2 KB              |
| **Recommendation**  |                          | **✓**              |

**Build it yourself.** The tar header format is 512 bytes of octal-encoded ASCII — simpler than most RFCs you'll encounter. Forking the `Header.encode()` logic into a focused, S3-aware utility gives you a lean package with zero unnecessary abstractions.
