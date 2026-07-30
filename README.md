# tar-gcs

Create tar archives from GCS objects using [server-side compose](https://cloud.google.com/storage/docs/composite-objects) — **zero data transfer, near-zero CPU**.

Instead of downloading files to build a tar locally, the library uploads tiny 512B tar headers and composes them together with source objects entirely on GCS. Files of any size — terabytes included — are referenced in-place.

```js
import { Storage } from '@google-cloud/storage';
import { createTar } from 'tar-gcs';

// Pass bucket as a string + storage instance to resolve it
const storage = new Storage();

await createTar({
  storage,
  bucket: 'my-bucket',
  files: [
    'photos/vacation/img001.jpg',
    'documents/report.pdf',
    'data/export.csv',
  ],
  targetKey: 'archive.tar',
});

// Or pass a Bucket instance directly — no `storage` needed
const bucket = new Storage().bucket('my-bucket');

await createTar({
  bucket,
  files: ['data/export.csv'],
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
npm install tar-gcs @google-cloud/storage
```

`@google-cloud/storage` is a peer dependency — you bring your own instance.

## API

### `createTar(opts)`

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `bucket` | `string \| Bucket` | yes | — | GCS bucket name or Bucket instance |
| `storage` | `Storage` | when `bucket` is a string | — | GCS Storage instance |
| `files` | `(string \| TarFileSpec)[]` | yes | — | Object keys to include |
| `targetKey` | `string` | yes | — | Destination key for the tar |
| `workPrefix` | `string` | no | `"tmp/tar-gcs/"` | Temp work directory prefix |
| `padPrefix` | `string` | no | `"tmp/tar-gcs-pad/"` | Pad object cache prefix |
| `validation` | `boolean` | no | `true` | CRC32C integrity check on uploads |
| `lowMemory` | `boolean` | no | `false` | Process files page-by-page |

Returns: `Promise<{ key: string, size: string, crc32c: string }>`

#### File specs

Each entry in `files` can be a plain string (metadata fetched automatically) or an object:

```js
{ name: 'path/to/file', size: 12345, mtime: new Date() }
```

`size` and `mtime` are optional — the library fetches them from GCS if omitted.

### `TarGcsError`

Thrown for invalid config (missing `bucket`, `files`, or `targetKey`). Check `error.code` for `ErrCode.INVALID_CONFIG`.

## License

MIT
