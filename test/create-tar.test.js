import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { storage, BUCKET, upload } from './setup.js';
import { createTar } from '../src/index.js';

describe('createTar (integration)', () => {
  /** @type {import('@google-cloud/storage').Bucket} */
  let bucket;

  before(async () => {
    bucket = storage.bucket(BUCKET);
    await bucket.create({ resumable: false }).catch(() => {});
    // create a subdirectory object (trailing slash implies folder)
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

  it('creates an empty tar when prefix has no files', async () => {
    await createTar({
      storage,
      bucket: BUCKET,
      prefix: 'nonexistent-prefix/',
      targetKey: 'output-empty.tar',
      validation: false,
    });

    const [buf] = await bucket.file('output-empty.tar').download();
    assert.equal(buf.length, 1024); // just end-of-archive blocks
    // all bytes should be zero
    for (let i = 0; i < 1024; i++) {
      assert.equal(buf[i], 0);
    }
  });

  it('creates a tar from a single file', async () => {
    await upload('hello.txt', 'hello world\n');

    await createTar({
      storage,
      bucket: BUCKET,
      prefix: 'hello',
      targetKey: 'output-hello.tar',
      validation: false,
    });

    const [buf] = await bucket.file('output-hello.tar').download();

    // Header (512) + content (12) + padding to 512 (500) + end blocks (1024)
    // Total: 512 + 12 + 500 + 1024 = 2048
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
    await upload('hello.txt', 'hello world\n');
    await upload('hello-small.txt', 'x');

    await createTar({
      storage,
      bucket: BUCKET,
      prefix: 'hello',
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
    await upload('hello.txt', 'hello world\n');

    const result = await createTar({
      storage,
      bucket: BUCKET,
      prefix: 'hello',
      targetKey: 'output-meta.tar',
      validation: false,
    });

    assert.equal(result.key, 'output-meta.tar');
    assert.ok(typeof result.size === 'string');
    assert.ok(Number(result.size) > 0);
    // fake-gcs-server provides crc32c even for composed objects
    assert.ok(typeof result.crc32c === 'string');
  });
});
