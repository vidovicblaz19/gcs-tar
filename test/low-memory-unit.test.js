import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTar } from '../src/index.js';

class FakeFile {
  /**
   * @param {FakeBucket} bucket
   * @param {string} name
   */
  constructor(bucket, name) {
    this.bucket = bucket;
    this.name = name;
  }

  /**
   * @param {Buffer} data
   * @param {object} [opts]
   */
  async save(data, opts) {
    this.bucket.objects.set(this.name, Buffer.from(data));
    return [this];
  }

  async exists() {
    return [this.bucket.objects.has(this.name)];
  }

  async getMetadata() {
    const data = this.bucket.objects.get(this.name);
    if (!data) {
      const err = new Error(`Not found: ${this.name}`);
      // @ts-expect-error test fake
      err.code = 404;
      throw err;
    }
    return [{
      name: this.name,
      size: String(data.length),
      updated: this.bucket.updated,
      crc32c: '',
    }];
  }
}

class FakeBucket {
  constructor() {
    /** @type {Map<string, Buffer>} */
    this.objects = new Map();
    /** @type {string[][]} */
    this.combineCalls = [];
    this.maxCombineSources = 0;
    this.updated = new Date('2026-01-01T00:00:00Z');
  }

  /**
   * @param {string} name
   */
  file(name) {
    return new FakeFile(this, name);
  }

  /**
   * @param {{ prefix?: string, autoPaginate?: boolean }} [query]
   */
  async getFiles(query = {}) {
    const prefix = query.prefix ?? '';
    const files = [...this.objects.keys()]
      .filter((name) => name.startsWith(prefix))
      .sort()
      .map((name) => this.file(name));
    return [files];
  }

  /**
   * @param {(string|FakeFile)[]} sources
   * @param {string|FakeFile} destination
   */
  async combine(sources, destination) {
    const names = sources.map((source) => (typeof source === 'string' ? source : source.name));
    this.combineCalls.push(names);
    this.maxCombineSources = Math.max(this.maxCombineSources, names.length);
    assert.ok(names.length <= 32, `combine received ${names.length} sources`);

    const chunks = names.map((name) => {
      const data = this.objects.get(name);
      if (!data) throw new Error(`Missing compose source: ${name}`);
      return data;
    });

    const key = typeof destination === 'string' ? destination : destination.name;
    this.objects.set(key, Buffer.concat(chunks));
    return [this.file(key)];
  }

  /**
   * @param {{ prefix?: string, force?: boolean }} [query]
   */
  async deleteFiles(query = {}) {
    const prefix = query.prefix ?? '';
    for (const name of [...this.objects.keys()]) {
      if (name.startsWith(prefix)) this.objects.delete(name);
    }
  }
}

describe('createTar lowMemory', () => {
  it('composes pages in batches of at most 32 sources', async () => {
    const bucket = new FakeBucket();
    const files = Array.from(
      { length: 40 },
      (_, i) => `file-${String(i).padStart(3, '0')}.txt`,
    );

    for (const name of files) {
      bucket.objects.set(name, Buffer.from('x'));
    }

    const result = await createTar({
      bucket: /** @type {any} */ (bucket),
      files,
      targetKey: 'output.tar',
      lowMemory: true,
      validation: false,
    });

    assert.equal(result.key, 'output.tar');
    assert.equal(Number(result.size), files.length * 1024 + 1024);
    assert.ok(
      bucket.maxCombineSources <= 32,
      `expected max 32 compose sources, got ${bucket.maxCombineSources}`,
    );

    const archive = bucket.objects.get('output.tar');
    assert.ok(archive);

    const firstName = archive.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    assert.equal(firstName, files[0]);

    const lastHeaderOffset = (files.length - 1) * 1024;
    const lastName = archive
      .subarray(lastHeaderOffset, lastHeaderOffset + 100)
      .toString('utf8')
      .replace(/\0.*$/, '');
    assert.equal(lastName, files[files.length - 1]);

    for (let i = archive.length - 1024; i < archive.length; i++) {
      assert.equal(archive[i], 0);
    }
  });

  it('creates an empty archive in lowMemory mode', async () => {
    const bucket = new FakeBucket();

    const result = await createTar({
      bucket: /** @type {any} */ (bucket),
      files: [],
      targetKey: 'empty.tar',
      lowMemory: true,
      validation: false,
    });

    assert.equal(result.key, 'empty.tar');
    assert.equal(Number(result.size), 1024);

    const archive = bucket.objects.get('empty.tar');
    assert.ok(archive);
    assert.equal(archive.length, 1024);
    assert.ok(archive.every((byte) => byte === 0));
  });
});
