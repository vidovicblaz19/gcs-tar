# Changelog

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
