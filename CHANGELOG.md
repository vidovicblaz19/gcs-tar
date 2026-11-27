# Changelog

## 1.1.3

### Fixed
- Long filenames are now measured by UTF-8 byte length, so multibyte names of 100 bytes or more correctly use GNU LongLink records.
- Temporary header object keys now use per-entry indexes instead of the source filename, avoiding GCS object-name limits for very long names and collisions when the same name appears twice.

## 1.1.2

### Changed
- Publishing now uses npm trusted publishing (OIDC) and staged publishing. GitHub Actions stages the release and a maintainer approves it with 2FA before it becomes installable.
- The Publish workflow pins npm `11.19.1` and no longer requires an `NPM_TOKEN` secret.
- Added `RELEASING.md` and linked it from the README.

## 1.1.1

### Changed
- CI now tests Node.js 18, 20, 22, 24, and 26, verifies the committed `dist/` bundle, and uses `actions/checkout@v7` / `actions/setup-node@v7`.
- Publish workflow now runs integration tests, checks the release tag against `package.json`, and publishes GitHub prereleases under the npm `next` dist-tag.
- Pinned the fake GCS emulator image to `1.56.1`.

## 1.1.0

### Added
- `largeFileSupport` option (default `true`) to encode tar entries of 8 GiB or larger using GNU base-256 size fields. This is supported by GNU tar and bsdtar; set `largeFileSupport: false` to reject oversized entries with `ErrCode.FILE_TOO_LARGE` instead.

### Fixed
- Entries of 8 GiB or larger were silently encoded with a truncated octal size field, producing invalid archives.

## 1.0.4

### Fixed
- `lowMemory` mode now composes each page through the merge-tree helper instead of sending all page sources to a single compose request. Pages that produced more than 32 sources exceeded GCS's compose limit and failed.

## 1.0.3

### Fixed
- `pad512` overflowed above 2 GiB due to 32-bit bitwise arithmetic, producing negative or zero padding for large files. Padding now uses arithmetic rounding.

## 1.0.2

### Added
- README: lifecycle/cleanup recommendations for `tmp/gcs-tar/` and `tmp/gcs-tar-pad/sz/` (24h TTL).

## 1.0.1

### Added
- GNU tar LongLink (`typeflag 'L'`) support for filenames >= 100 chars (`encodeLongLinkHeader`). Full pathnames are now preserved in a `././@LongLink` record; the regular header carries a best-effort truncated name as a fallback.
- Integration tests for edge cases:
  - 100 small files (1 byte each, exercises the 2-level compose merge tree and pad subsystem)
  - 5 MB file (large-object compose correctness)
  - Long filenames: 80, 99, 100, and 200 characters (via LongLink extension)

### Fixed
- Filenames > 99 chars were silently truncated to the first 99 bytes of the POSIX name field. Long names now round-trip correctly through LongLink records.

## 1.0.0

- Initial release: server-side tar creation from GCS objects using compose API.
