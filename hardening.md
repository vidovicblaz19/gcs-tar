# Concurrency hardening

## The problem

Multiple `createTar()` calls running concurrently on the same bucket can interfere:

### Pad objects — safe ✅

```
tmp/tar-gcs-pad/1, 2, 4, …, 512
tmp/tar-gcs-pad/sz/24, …
```

- Base pads are **idempotent**: `ensureBasePads()` skips existing objects. Two concurrent runs checking `exists()` → both see `false` → both upload. One write wins, but content is identical (all zeros). Harmless.
- Cached combined pads in `ensurePad()`: same race. Two runs both try to compose `sz/24` from pad/16 + pad/8. One compose succeeds, the other overwrites with identical bytes. **Benign**, but wastes a compose call.

### Work files — safe ✅

```
tmp/tar-gcs/r3k7p001/headers/file1.jpg
tmp/tar-gcs/r3k7p001/end
```

Each `createTar()` call generates a unique run token on entry. All work objects are scoped under `tmp/tar-gcs/{token}/`. Two concurrent runs never share the same work path.

### Compose intermediates — safe ✅

```
tmp/tar-gcs/r3k7p001/int/l0/00000
tmp/tar-gcs/r3k7p001/int/l1/00000
```

Intermediates live under the run's work directory, not near the destination key. Different runs (same or different targetKey) are fully isolated. The final `bucket.combine(results, targetKey)` writes only the finished tar to the user-requested key.

## Isolation requirements

| Resource            | Location              | Safe? |
|---------------------|-----------------------|-------|
| Base pads           | `tmp/tar-gcs-pad/`    | Yes   |
| Cached combined pads| `tmp/tar-gcs-pad/sz/` | Yes   |
| End marker          | `pad/512` × 2         | Yes   |
| Headers             | `tmp/tar-gcs/{token}/`| Yes   |
| Compose intermediate| `tmp/tar-gcs/{token}/`| Yes   |

## Solution: run-scoped work prefix

Each `createTar()` call derives a **short unique run token** on entry. Work files, intermediates, and end markers are placed under `tmp/tar-gcs/{runToken}/`. The token is a compact string — not a UUID.

```js
const runToken = Math.random().toString(36).slice(2, 8)   // 6 random alphanumeric
               + Date.now().toString(36).slice(-4)         // 4 timestamp chars
// → "r3k7p001"
```

Resulting layout during a run:

```
tmp/tar-gcs-pad/               ← shared, idempotent (never cleaned)
├── 1, 2, 4, ..., 512          ← base pads (end-of-archive = pad/512 × 2)
└── sz/24, sz/36, ...          ← cached combined pads

tmp/tar-gcs/                    ← per-run, scoped (cleaned after)
└── r3k7p001/
    ├── headers/
    │   └── file1.jpg
    └── int/
        ├── l0/
        │   ├── 00000
        │   └── 00001
        └── l1/
            └── 00000

targetKey                       ← only final tar lands here
```

All intermediate compose objects live under `tmp/tar-gcs/{token}/int/` — never near the destination key. Only the fully assembled tar is written to `targetKey`.

## What happens at the end

After the final compose succeeds, the run's work directory is cleaned:

```js
await bucket.deleteFiles({ prefix: `${workPrefix}${token}/` })
```

`tmp/tar-gcs-pad/` is never cleaned — pads and end marker are permanent shared resources.

If a run crashes mid-way, orphaned temp objects remain. A separate TTL/lifecycle policy on the bucket (e.g., delete `tmp/tar-gcs/` objects older than 1 day) handles this out of band.

## Compose failure handling

`composeAll` uses `Promise.allSettled` for parallel batch composes within each level. If any batch fails:

1. All successfully created intermediates at the failing level are cleaned up
2. An `AggregateError` is thrown containing every underlying failure
3. The caller handles cleanup of its own work directory

Cleanup itself also uses `allSettled` — a failed delete won't mask a compose error or crash the process.

## Low-memory mode

When `lowMemory: true` is set in config, `createTar()` processes files page by page instead of loading all metadata at once. Each page (500 files by default) is composed into an intermediate tar segment immediately, then the segments are stitched together at the end. Memory usage is bounded to one page worth of metadata + compose source keys.

Normal mode: `listObjects` → load all → upload all headers → compose all at once (fastest, unbounded memory).
Low-memory mode: `listObjectsPaged` → for each page: upload headers, compose segment → compose segments (slower, bounded memory).

## Open question

Is a 10-character run token acceptable? (6 random alphanumeric + 4 timestamp hex). Collision probability is negligible for practical concurrency (< 1 in 10^9 for two simultaneous runs). Alternative: let the user supply their own `runToken` in opts and only generate one if not provided.
