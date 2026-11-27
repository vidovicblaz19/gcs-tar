# gcs-tar

Create tar archives from GCS objects using [server-side compose](https://cloud.google.com/storage/docs/composite-objects) — **zero data transfer, near-zero CPU**.

Instead of downloading files to build a tar locally, the library uploads tiny 512B tar headers and composes them together with source objects entirely on GCS. Files of any size — terabytes included — are referenced in-place.

```js
import { Storage } from '@google-cloud/storage';
import { createTar } from 'gcs-tar';

const bucket = new Storage().bucket('my-bucket');

await createTar({
  bucket,
  files: [
    'photos/vacation/img001.jpg',
    'documents/report.pdf',
    'data/export.csv',
  ],
  targetKey: 'archive.tar',
});
// => { key: 'archive.tar', size: '15204352', crc32c: 'abc123==' }
```

## How it works

For each file, a 512B tar header is uploaded. Padding (0–511B) is assembled from pre-cached zero-blocks. All parts — headers, source files, pads, end-of-archive — are composed server-side using GCS's compose API (up to 32 parts per call, batched in a merge tree for larger sets).

```
┌──────────┐  ┌──────────────┐  ┌────────┐
│  header  │  │  source file │  │  pad   │  …  × N files  …  end-blocks
│  512 B   │  │   (in-place) │  │ 0-511B │
└──────────┘  └──────────────┘  └────────┘
     ▲              ▲               ▲
  uploaded      already in        cached
  as object     source bucket     zero-fill
```

## Install

```
npm install gcs-tar @google-cloud/storage
```

`@google-cloud/storage` is a peer dependency — you bring your own instance.

Node.js 18 or newer is required. CI tests Node 18, 20, 22, 24, and 26.

## API

### `createTar(opts)`

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `bucket` | `Bucket` | yes | — | GCS Bucket instance |
| `files` | `(string \| TarFileSpec)[]` | yes | — | Object keys to include |
| `targetKey` | `string` | yes | — | Destination key for the tar |
| `workPrefix` | `string` | no | `"tmp/gcs-tar/"` | Temp work directory prefix |
| `padPrefix` | `string` | no | `"tmp/gcs-tar-pad/"` | Pad object cache prefix |
| `validation` | `boolean` | no | `true` | CRC32C integrity check on uploads |
| `lowMemory` | `boolean` | no | `false` | Process files page-by-page |
| `largeFileSupport` | `boolean` | no | `true` | GNU base-256 encoding for entries >= 8 GiB |

With `lowMemory: true`, files are resolved and composed one page at a time. Each page is composed into an intermediate segment using the same merge tree as the normal path, then the segments are stitched together. This reduces metadata memory usage and keeps every compose request within GCS's 32-source limit.

Tar's classic octal size field tops out just under 8 GiB per entry. With `largeFileSupport` enabled (default), entries of 8 GiB or larger use GNU base-256 encoding. GNU tar and bsdtar support this, but some strict or legacy tar readers may not. Set `largeFileSupport: false` to reject such entries with `ErrCode.FILE_TOO_LARGE` instead. This limit is per entry; total archive size is still bounded by GCS's 5 TiB object limit.

Returns: `Promise<{ key: string, size: string, crc32c: string }>`

#### File specs

Each entry in `files` can be a plain string (metadata fetched automatically) or an object:

```js
{ name: 'path/to/file', size: 12345, mtime: new Date() }
```

`size` and `mtime` are optional — the library fetches them from GCS if omitted.

## Cleanup

The library creates temporary objects under `workPrefix` (default `tmp/gcs-tar/`) — headers, intermediate merges — and cached zero-fill padding objects under `padPrefix` (default `tmp/gcs-tar-pad/sz/`). These are **not** auto-cleaned up.

Recommended: set a **lifecycle rule** on your bucket to delete objects older than 24 hours:

```
tmp/gcs-tar/       → delete after 24 hours
tmp/gcs-tar-pad/sz/ → delete after 24 hours
```

## `TarGcsError`

Thrown for invalid config (missing `bucket`, `files`, or `targetKey`), invalid entry sizes, and entries that exceed tar's octal size limit when `largeFileSupport` is disabled. Check `error.code` for `ErrCode.INVALID_CONFIG`, `ErrCode.INVALID_SIZE`, or `ErrCode.FILE_TOO_LARGE`.

## License

MIT
