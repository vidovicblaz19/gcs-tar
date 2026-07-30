/**
 * @param {number} num
 * @param {number} size
 * @returns {string}
 */
function formatOctal(num, size) {
  const str = Math.floor(num).toString(8);
  const pad = size - str.length - 1;
  return (pad > 0 ? '0'.repeat(pad) + str : str.slice(0, size - 1)) + '\0';
}

/**
 * @param {Buffer} buf
 * @param {number} off
 * @param {number} size
 * @param {number} num
 */
function writeOctal(buf, off, size, num) {
  buf.write(formatOctal(num, size), off, size, 'ascii');
}

/**
 * @param {Buffer} buf
 * @param {number} off
 * @param {number} size
 * @param {string} str
 */
function writeString(buf, off, size, str) {
  buf.write(str + '\0', off, size, 'utf8');
}

/**
 * @typedef {object} TarEntry
 * @property {string}  name       - file path in archive
 * @property {number}  size       - file size in bytes
 * @property {number}  [mode]     - unix permissions (default 0o644)
 * @property {Date}    [mtime]    - modification time (default now)
 * @property {number}  [uid]      - owner uid (default 0)
 * @property {number}  [gid]      - owner gid (default 0)
 * @property {string}  [uname]    - owner name (default "")
 * @property {string}  [gname]    - group name (default "")
 * @property {string}  [typeflag] - '0'=file, '5'=dir (default '0')
 */

/**
 * Create a 512-byte tar header block for a file entry.
 *
 * @param {TarEntry} entry
 * @returns {Buffer}
 */
export function encodeHeader(entry) {
  const buf = Buffer.alloc(512);

  const name = entry.name || '';
  const mode = entry.mode ?? 0o644;
  const uid = entry.uid ?? 0;
  const gid = entry.gid ?? 0;
  const size = entry.size ?? 0;
  const mtime = entry.mtime ?? new Date();
  const uname = entry.uname ?? 'root';
  const gname = entry.gname ?? 'root';
  const typeflag = entry.typeflag ?? '0';

  writeString(buf, 0, 100, name);
  writeOctal(buf, 100, 8, mode);
  writeOctal(buf, 108, 8, uid);
  writeOctal(buf, 116, 8, gid);
  writeOctal(buf, 124, 12, size);

  const mtimeSec = Math.floor(mtime.getTime() / 1000);
  writeOctal(buf, 136, 12, mtimeSec);

  buf.write(typeflag, 156, 1, 'ascii');

  writeString(buf, 257, 6, 'ustar');
  buf.write('00', 263, 2, 'ascii');
  writeString(buf, 265, 32, uname);
  writeString(buf, 297, 32, gname);

  let sum = 8 * 0x20;
  for (let i = 0; i < 148; i++) {
    sum += buf[i];
  }
  for (let i = 156; i < 512; i++) {
    sum += buf[i];
  }
  writeOctal(buf, 148, 7, sum);

  return buf;
}

/**
 * Round size up to the next 512-byte boundary.
 *
 * @param {number} size
 * @returns {number}
 */
export function pad512(size) {
  return (size + 511) & ~511;
}
/**
 * Power-of-2 pad sizes used as building blocks. Any padding 0–511
 * can be assembled from these. End-of-archive is two pad/512 objects.
 * @type {number[]}
 */
export const PAD_SIZES = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];

/**
 * Create a 512-byte GNU tar LongLink header (typeflag 'L') for
 * filenames longer than 100 bytes. The body (pathname + NUL,
 * padded to 512) must follow as a separate tar record.
 *
 * @param {string} path - the full file path (> 99 chars)
 * @returns {Buffer}
 */
export function encodeLongLinkHeader(path) {
  const buf = Buffer.alloc(512);

  writeString(buf, 0, 100, '././@LongLink');
  writeOctal(buf, 100, 8, 0);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, path.length + 1);
  writeOctal(buf, 136, 12, 0);
  buf.write('L', 156, 1, 'ascii');
  writeString(buf, 257, 6, 'ustar');
  buf.write('00', 263, 2, 'ascii');
  writeString(buf, 265, 32, '');
  writeString(buf, 297, 32, '');

  let sum = 8 * 0x20;
  for (let i = 0; i < 148; i++) sum += buf[i];
  for (let i = 156; i < 512; i++) sum += buf[i];
  writeOctal(buf, 148, 7, sum);

  return buf;
}

/**
 * Decompose a number into power-of-2 components (descending).
 * Returns an empty array for 0.
 *
 * @param {number} n - value to decompose (0–1023)
 * @returns {number[]}
 */
export function decomposeBits(n) {
  const bits = [];
  let rem = n;
  for (let bit = 512; bit >= 1; bit >>= 1) {
    if (rem >= bit) {
      bits.push(bit);
      rem -= bit;
    }
  }
  return bits;
}
