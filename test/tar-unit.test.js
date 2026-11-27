import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeHeader, pad512, decomposeBits, PAD_SIZES } from '../src/tar.js';

describe('encodeHeader', () => {
  it('creates a 512-byte buffer', () => {
    const h = encodeHeader({ name: 'hello.txt', size: 11 });
    assert.equal(h.length, 512);
  });

  it('sets the file name', () => {
    const h = encodeHeader({ name: 'hello.txt', size: 11 });
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    assert.equal(name, 'hello.txt');
  });

  it('sets the file size as octal', () => {
    const h = encodeHeader({ name: 'f', size: 11 });
    const sizeStr = h.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    // 11 decimal = 13 octal, zero-padded to field width (12 chars incl null)
    assert.equal(parseInt(sizeStr, 8), 11);
  });

  it('has a valid checksum', () => {
    const h = encodeHeader({ name: 'x', size: 0, mtime: new Date(0) });
    const cksumStr = h.subarray(148, 156).toString('utf8').replace(/\0.*$/, '').trim();
    const expectedCksum = parseInt(cksumStr, 8);

    let sum = 8 * 0x20;
    for (let i = 0; i < 148; i++) sum += h[i];
    for (let i = 156; i < 512; i++) sum += h[i];
    assert.equal(sum, expectedCksum);
  });

  it('uses ustar magic', () => {
    const h = encodeHeader({ name: 'a', size: 0 });
    const magic = h.subarray(257, 263).toString('utf8');
    assert.equal(magic, 'ustar\0');
  });

  it('defaults mode to 0o644', () => {
    const h = encodeHeader({ name: 'a', size: 0 });
    const mode = h.subarray(100, 108).toString('utf8').replace(/\0.*$/, '').trim();
    assert.equal(parseInt(mode, 8), 0o644);
  });

  it('accepts custom mode', () => {
    const h = encodeHeader({ name: 'a', size: 0, mode: 0o755 });
    const mode = h.subarray(100, 108).toString('utf8').replace(/\0.*$/, '').trim();
    assert.equal(parseInt(mode, 8), 0o755);
  });
});

describe('pad512', () => {
  it('returns same number if already aligned', () => {
    assert.equal(pad512(512), 512);
    assert.equal(pad512(1024), 1024);
    assert.equal(pad512(0), 0);
  });

  it('rounds up to next 512 boundary', () => {
    assert.equal(pad512(1), 512);
    assert.equal(pad512(500), 512);
    assert.equal(pad512(513), 1024);
    assert.equal(pad512(1000), 1024);
  });

  it('handles sizes above the 32-bit boundary', () => {
    const gib = 1024 ** 3;

    assert.equal(pad512(2 * gib - 1), 2 * gib);
    assert.equal(pad512(2 * gib), 2 * gib);
    assert.equal(pad512(2 * gib + 1), 2 * gib + 512);
    assert.equal(pad512(3 * gib), 3 * gib);
    assert.equal(pad512(4 * gib), 4 * gib);
    assert.equal(pad512(5 * 1024 * gib), 5 * 1024 * gib);
  });
});

describe('PAD_SIZES', () => {
  it('contains powers of 2 from 1 to 512', () => {
    assert.deepEqual(PAD_SIZES, [1, 2, 4, 8, 16, 32, 64, 128, 256, 512]);
  });

  it('sums to enough for any padding 1-511', () => {
    const total = PAD_SIZES.reduce((a, b) => a + b, 0);
    assert.equal(total, 1023);
  });
});

describe('decomposeBits', () => {
  it('returns empty for 0', () => {
    assert.deepEqual(decomposeBits(0), []);
  });

  it('decomposes power of 2 into itself', () => {
    assert.deepEqual(decomposeBits(64), [64]);
    assert.deepEqual(decomposeBits(512), [512]);
  });

  it('decomposes composite numbers', () => {
    assert.deepEqual(decomposeBits(100), [64, 32, 4]);
    assert.deepEqual(decomposeBits(255), [128, 64, 32, 16, 8, 4, 2, 1]);
    assert.deepEqual(decomposeBits(511), [256, 128, 64, 32, 16, 8, 4, 2, 1]);
  });

  it('all decompositions sum to the input', () => {
    for (let n = 1; n <= 511; n++) {
      const bits = decomposeBits(n);
      const sum = bits.reduce((a, b) => a + b, 0);
      assert.equal(sum, n);
    }
  });
});
