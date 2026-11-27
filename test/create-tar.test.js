import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { storage, BUCKET, upload } from './setup.js';
import { createTar } from '../src/index.js';
import { pad512 } from '../src/tar.js';

describe('createTar (integration)', () => {
  /** @type {import('@google-cloud/storage').Bucket} */
  let bucket;

  before(async () => {
    bucket = storage.bucket(BUCKET);
    await bucket.create({ resumable: false }).catch(() => {});
    await upload('sub/', '');
  });

  after(async () => {
    try {
      await bucket.deleteFiles({ prefix: 'sub/' });
      await bucket.deleteFiles({ prefix: 'hello' });
      await bucket.deleteFiles({ prefix: 'tmp/' });
      await bucket.deleteFiles({ prefix: 'output' });
      await bucket.file('output-empty.tar').delete().catch(() => {});
    } catch {
      // ignore cleanup errors
    }
  });

  it('creates an empty tar when files array is empty', async () => {
    await createTar({
      bucket,
      files: [],
      targetKey: 'output-empty.tar',
      validation: false,
    });

    const [buf] = await bucket.file('output-empty.tar').download();
    assert.equal(buf.length, 1024);
    for (let i = 0; i < 1024; i++) {
      assert.equal(buf[i], 0);
    }
  });

  it('creates a tar from a single file', async () => {
    const key = 'hello.txt';
    await upload(key, 'hello world\n');

    await createTar({
      bucket,
      files: [key],
      targetKey: 'output-hello.tar',
      validation: false,
    });

    const [buf] = await bucket.file('output-hello.tar').download();
    assert.equal(buf.length, 2048);

    // Check header checksum
    let sum = 8 * 0x20;
    for (let i = 0; i < 148; i++) sum += buf[i];
    for (let i = 156; i < 512; i++) sum += buf[i];
    const cksumStr = buf.subarray(148, 156).toString('utf8').replace(/\0.*$/, '').trim();
    assert.equal(sum, parseInt(cksumStr, 8));

    // Check file name in header
    const name = buf.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    assert.equal(name, 'hello.txt');

    // Check file content at offset 512-524
    const content = buf.subarray(512, 512 + 12).toString('utf8');
    assert.equal(content, 'hello world\n');

    // Check end blocks are zeros at the end
    const end = buf.subarray(2048 - 1024);
    for (let i = 0; i < end.length; i++) {
      assert.equal(end[i], 0);
    }
  });

  it('creates a tar from two files with different sizes', async () => {
    const keys = ['hello.txt', 'hello-small.txt'];
    await upload(keys[0], 'hello world\n');
    await upload(keys[1], 'x');

    await createTar({
      bucket,
      files: keys,
      targetKey: 'output-multi.tar',
      validation: false,
    });

    const [buf] = await bucket.file('output-multi.tar').download();

    // File 1: header (512) + "hello world\n" (12) + pad (500) = 1024
    // File 2: header (512) + "x" (1) + pad (511) = 1024
    // End: 1024
    // Total: 3072
    assert.equal(buf.length, 3072);

    // First header name at offset 0
    const name1 = buf.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    assert.ok(name1 === 'hello.txt' || name1 === 'hello-small.txt');

    // First file content at 512
    const expected1 = name1 === 'hello.txt' ? 'hello world\n' : 'x';
    assert.equal(buf.subarray(512, 512 + expected1.length).toString('utf8'), expected1);

    // Second header at 1024
    const name2 = buf.subarray(1024, 1024 + 100).toString('utf8').replace(/\0.*$/, '');
    assert.ok(name2 !== name1);
    assert.ok(name2 === 'hello-small.txt' || name2 === 'hello.txt');

    // Second content at 1536 (1024 + 512)
    const expected2 = name2 === 'hello.txt' ? 'hello world\n' : 'x';
    assert.equal(buf.subarray(1536, 1536 + expected2.length).toString('utf8'), expected2);

    // End blocks
    for (let i = buf.length - 1024; i < buf.length; i++) {
      assert.equal(buf[i], 0);
    }
  });

  it('returns metadata for the composed tar', async () => {
    const key = 'hello.txt';
    await upload(key, 'hello world\n');

    const result = await createTar({
      bucket,
      files: [key],
      targetKey: 'output-meta.tar',
      validation: false,
    });

    assert.equal(result.key, 'output-meta.tar');
    assert.ok(typeof result.size === 'string');
    assert.ok(Number(result.size) > 0);
    assert.ok(typeof result.crc32c === 'string');
  });

  it('accepts a Bucket instance directly', async () => {
    const key = 'hello.txt';
    await upload(key, 'hello world\n');

    const result = await createTar({
      bucket,
      files: [key],
      targetKey: 'output-bucket-instance.tar',
      validation: false,
    });

    assert.equal(result.key, 'output-bucket-instance.tar');
    assert.ok(Number(result.size) > 0);

    const [buf] = await bucket.file('output-bucket-instance.tar').download();
    const name = buf.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    assert.equal(name, 'hello.txt');
  });

  it('handles many small files (100 files, triggers merge tree)', { timeout: 120000 }, async () => {
    const count = 100;
    const keys = [];
    const content = Buffer.from('x');

    for (let i = 0; i < count; i++) {
      const key = `sub/many/file-${String(i).padStart(3, '0')}.txt`;
      keys.push(key);
      await upload(key, content);
    }

    await createTar({
      bucket,
      files: keys,
      targetKey: 'output-many.tar',
      validation: false,
    });

    const [buf] = await bucket.file('output-many.tar').download();

    const expectedLen = count * 1024 + 1024;
    assert.equal(buf.length, expectedLen);

    for (let i = 0; i < count; i += 11) {
      const off = i * 1024;
      const name = buf.subarray(off, off + 100).toString('utf8').replace(/\0.*$/, '');
      assert.equal(name, `sub/many/file-${String(i).padStart(3, '0')}.txt`);
    }

    for (let i = expectedLen - 1024; i < expectedLen; i++) {
      assert.equal(buf[i], 0);
    }
  });

  it('handles large files (5MB)', { timeout: 60000 }, async () => {
    const size = 5 * 1024 * 1024;
    const content = Buffer.alloc(size, 'A');
    const key = 'sub/big/large-5mb.bin';

    await upload(key, content);

    await createTar({
      bucket,
      files: [key],
      targetKey: 'output-big.tar',
      validation: false,
    });

    const [buf] = await bucket.file('output-big.tar').download();

    const expectedLen = 512 + size + 1024;
    assert.equal(buf.length, expectedLen);

    const name = buf.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    assert.equal(name, 'sub/big/large-5mb.bin');

    assert.equal(buf[512], 'A'.charCodeAt(0));
    assert.equal(buf[512 + size - 1], 'A'.charCodeAt(0));

    for (let i = expectedLen - 1024; i < expectedLen; i++) {
      assert.equal(buf[i], 0);
    }
  });

  it('handles long filenames (80, 99, and 100 chars)', async () => {
    const prefix = 'sub/long/';
    /**
     * @param {number} len
     */
    const padChar = (len) => 'a'.repeat(len);
    const ext = '.txt';

    /**
     * @param {number} totalLen
     */
    const makeName = (totalLen) => {
      const bodyLen = totalLen - prefix.length - ext.length;
      return prefix + padChar(bodyLen) + ext;
    };

    const name80 = makeName(80);
    const name99 = makeName(99);
    const name100 = makeName(100);

    const content = Buffer.from('long-name-test');

    await upload(name80, content);
    await upload(name99, content);
    await upload(name100, content);

    await createTar({
      bucket,
      files: [name80, name99, name100],
      targetKey: 'output-long.tar',
      validation: false,
    });

    const [buf] = await bucket.file('output-long.tar').download();

    /**
     * @param {number} off
     */
    const readName = (off) => buf.subarray(off, off + 100).toString('utf8').replace(/\0.*$/, '');

    assert.equal(readName(0), name80);
    assert.equal(readName(1024), name99);

    // name100 has a LongLink entry: LL header (512) + LL body (512) = 1024B
    // The file header is at offset 2048, but we read full name from LongLink
    // The LongLink body starts at offset 2560 (2048 + 512 LL header) and
    // contains the full pathname + NUL
    const llBodyOff = 2048 + 512;
    const longNameFromLL = buf.subarray(llBodyOff, llBodyOff + name100.length).toString('utf8');
    assert.equal(longNameFromLL, name100);

    // File header at 3072 has best-effort truncated name (up to 100B field)
    const truncated100 = readName(3072);
    assert.equal(truncated100, name100.substring(0, 100));

    // 2 short-name entries (1024 each) + 1 long-name entry with LL (2048) + end (1024)
    const expectedLen = 2 * 1024 + 2048 + 1024;
    assert.equal(buf.length, expectedLen);

    for (let i = expectedLen - 1024; i < expectedLen; i++) {
      assert.equal(buf[i], 0);
    }
  });

  it('handles very long filenames (200 chars)', async () => {
    const prefix = 'sub/';
    const body = 'z'.repeat(200 - prefix.length);
    const name200 = prefix + body;

    const content = Buffer.from('deep-path-content');

    await upload(name200, content);

    await createTar({
      bucket,
      files: [name200],
      targetKey: 'output-verylong.tar',
      validation: false,
    });

    const [buf] = await bucket.file('output-verylong.tar').download();

    // LongLink header (512) then body at offset 512
    const llBodyOff = 512;
    const nameFromLL = buf.subarray(llBodyOff, llBodyOff + name200.length).toString('utf8');
    assert.equal(nameFromLL, name200);
    assert.equal(buf[llBodyOff + name200.length], 0); // NUL terminator

    // File header at offset 1024 has best-effort truncated name (up to 100B field)
    const fileHdrName = buf.subarray(1024, 1024 + 100).toString('utf8').replace(/\0.*$/, '');
    assert.equal(fileHdrName, name200.substring(0, 100));

    // File content at offset 1536 (1024 + 512)
    const fileContent = buf.subarray(1536, 1536 + content.length).toString('utf8');
    assert.equal(fileContent, 'deep-path-content');

    // LL header (512) + LL body (512) + file header (512) + padded content (512) + end (1024)
    const expectedLen = 4 * 512 + 1024;
    assert.equal(buf.length, expectedLen);

    for (let i = expectedLen - 1024; i < expectedLen; i++) {
      assert.equal(buf[i], 0);
    }
  });

  it('handles multibyte filenames by UTF-8 byte length', async () => {
    const prefix = 'sub/multibyte/';
    const name = `${prefix}${'é'.repeat(60)}.txt`;
    const nameBytes = Buffer.byteLength(name, 'utf8');
    const content = Buffer.from('multibyte-name');

    assert.ok(nameBytes > 100);

    await upload(name, content);

    await createTar({
      bucket,
      files: [name],
      targetKey: 'output-multibyte.tar',
      validation: false,
    });

    const [buf] = await bucket.file('output-multibyte.tar').download();

    // LongLink header (512) then body at offset 512.
    const llBodyOff = 512;
    const nameFromLL = buf.subarray(llBodyOff, llBodyOff + nameBytes).toString('utf8');
    assert.equal(nameFromLL, name);
    assert.equal(buf[llBodyOff + nameBytes], 0); // NUL terminator

    // The regular header at 1024 has a best-effort truncated name.
    const fileHdrName = buf.subarray(1024, 1124).toString('utf8').replace(/\0.*$/, '');
    assert.ok(name.startsWith(fileHdrName));
    assert.ok(Buffer.byteLength(fileHdrName, 'utf8') <= 100);

    // File content at 1536 (1024 + 512).
    const fileContent = buf.subarray(1536, 1536 + content.length).toString('utf8');
    assert.equal(fileContent, 'multibyte-name');

    assert.equal(buf.length, 4 * 512 + 1024);
  });

  it('handles very long filenames near the GCS object-name limit', async () => {
    const prefix = 'sub/';
    const name = prefix + 'q'.repeat(1000 - prefix.length);
    const content = Buffer.from('limit-name');

    assert.equal(Buffer.byteLength(name, 'utf8'), 1000);

    await upload(name, content);

    await createTar({
      bucket,
      files: [name],
      targetKey: 'output-name-limit.tar',
      validation: false,
    });

    const [buf] = await bucket.file('output-name-limit.tar').download();

    const llBodyOff = 512;
    assert.equal(buf.subarray(llBodyOff, llBodyOff + 1000).toString('utf8'), name);
    assert.equal(buf[llBodyOff + 1000], 0);

    // A 1000-byte name plus NUL occupies three 512-byte LongLink body blocks.
    const llBodyLen = pad512(1000 + 1);
    const fileHeaderOff = llBodyOff + llBodyLen;
    const fileContent = buf
      .subarray(fileHeaderOff + 512, fileHeaderOff + 512 + content.length)
      .toString('utf8');
    assert.equal(fileContent, 'limit-name');

    assert.equal(buf.length, 512 + llBodyLen + 512 + 512 + 1024);
  });

  it('keeps distinct headers for duplicate names', async () => {
    const key = 'hello-duplicate.txt';
    const content = Buffer.from('duplicate');
    const firstMtime = new Date('2001-01-01T00:00:00Z');
    const secondMtime = new Date('2002-01-01T00:00:00Z');

    await upload(key, content);

    await createTar({
      bucket,
      files: [
        { name: key, size: content.length, mtime: firstMtime },
        { name: key, size: content.length, mtime: secondMtime },
      ],
      targetKey: 'output-duplicate.tar',
      validation: false,
    });

    const [buf] = await bucket.file('output-duplicate.tar').download();

    /**
     * @param {number} off
     * @returns {number}
     */
    const readMtime = (off) => {
      const raw = buf.subarray(off + 136, off + 148).toString('utf8').replace(/\0.*$/, '').trim();
      return parseInt(raw, 8);
    };

    assert.equal(readMtime(0), Math.floor(firstMtime.getTime() / 1000));
    assert.equal(readMtime(1024), Math.floor(secondMtime.getTime() / 1000));
    assert.equal(buf.length, 3 * 1024);
  });
});
