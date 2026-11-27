# Changelog

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
