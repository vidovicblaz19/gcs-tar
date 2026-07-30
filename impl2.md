# Implementation Plan v2 — Optimized padding with power-of-2 pad files

## Changes from v1

1. **Pad optimization**: Pre-create power-of-2 pad objects (1, 2, 4, 8, 16, 32, 64, 128, 256, 512) once per bucket under `tmp/tar-gcs-pad/`. Any padding N is decomposed into binary bits, then the needed pads are composed into a single cached pad object under `tmp/tar-gcs-pad/sz/N`. Subsequent operations with the same padding size reuse the cached pad — each file uses exactly 3 compose slots (header + source + 1 pad).

2. **Default prefixes**: `tmp/tar-gcs/` for work files, `tmp/tar-gcs-pad/` derived automatically for pad objects. Both configurable.

3. **End-of-archive**: Single 1024B object at `tmp/tar-gcs/end`, uploaded once, reused across all files (already the design — emphasized here for clarity).

## Directory layout in bucket

```
tmp/tar-gcs-pad/       # Pad objects — created once, reused forever
├── 1                  # 1-byte zero buffer (power-of-2 base pads)
├── 2
├── 4
├── 8
├── 16
├── 32
├── 64
├── 128
├── 256
├── 512
└── sz/                # Cached combined pads — lazily created
    ├── 24             # composed from pad/16 + pad/8
    ├── 100            # composed from pad/64 + pad/32 + pad/4
    └── ...

tmp/tar-gcs/            # Working files — per createTar call
├── headers/           # Tar header objects
│   └── <filename>
└── end                # 1024B end-of-archive marker
```

Clean separation: `tmp/tar-gcs-pad/` holds the reusable pad objects, `tmp/tar-gcs/` holds the per-operation headers and end marker. `padPrefix` is derived from `tempPrefix` by appending `-pad` unless overridden.

## New/updated functions

### `tar.js` — unchanged (encodeHeader, pad512, END_BLOCKS)

### `tar.js` — new additions

```
decomposeBits(n): number[]     // [64, 32, 4] for n=100, [] for n=0
```

### `gcs.js` — new

```
ensureBasePads(bucket, tempBase)     // Upload pad/1, pad/2, …, pad/512 if missing
ensurePad(bucket, tempBase, size)    // Return pad-sz/{size} key, creating it from bits if needed
```

### `gcs.js` — unchanged (listObjects, uploadBuffer, compose, composeAll)

### `index.js` — updated

- Calls `ensureBasePads()` at start of `createTar()`
- Uses `ensurePad()` per file instead of uploading raw padding buffers
- No more per-file padding uploads — pads are pre-cached

### `config.js` — default `tempPrefix` → `tmp/tar-gcs/`, `padPrefix` derived as `tmp/tar-gcs-pad/`

## Flow (updated)

```
1. ensureBasePads()        → create pad/1..pad/512 (idempotent)
2. listObjects(prefix)     → get file metadata
3. For each file:
   a. Upload tar header     → tmp/tar-gcs/headers/<filename>
   b. padLen = pad512(file.size) - file.size
   c. If padLen > 0: ensurePad(padLen) → tmp/tar-gcs-pad/sz/{padLen}
      (creates from power-of-2 pads if not cached, ~2nd-run instant)
4. Build source list: [hdr1, file1, pad-sz/N1, hdr2, file2, pad-sz/N2, …]
5. Upload end marker       → tmp/tar-gcs/end
6. composeAll(sources + end) → targetKey
7. Return { key, size, crc32c }
```

## Pad creation example (first run)

```
File sizes: 1000 → padLen = 512-488 = 24,  24 = 16+8
            1500 → padLen = 512-476 = 36,  36 = 32+4
            2048 → padLen = 0              (skip)

ensureBasePads() → uploads pad/1..pad/512 (10 objects, ~1KB total)

ensurePad(24):
  bits = [16, 8]
  compose([tmp/tar-gcs-pad/16, tmp/tar-gcs-pad/8]) → tmp/tar-gcs-pad/sz/24 ✓

ensurePad(36):
  bits = [32, 4]
  compose([tmp/tar-gcs-pad/32, tmp/tar-gcs-pad/4]) → tmp/tar-gcs-pad/sz/36 ✓
```

## Pad creation example (second run, same file sizes)

```
ensurePad(24): tmp/tar-gcs-pad/sz/24 already exists → instant ✓
ensurePad(36): tmp/tar-gcs-pad/sz/36 already exists → instant ✓
```

## Compose slot budget

Each file takes exactly 3 slots: header + source + 1 pad. → 10 files per $`\le 32`$ batch. Downside: an extra compose call per _unique_ padding size on first run to pre-compose the cached pad from powers of 2. Subsequent runs pay zero extra cost.
