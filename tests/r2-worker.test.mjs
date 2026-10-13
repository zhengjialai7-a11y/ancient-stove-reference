import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createGateway, receiptCanonical, PART_SIZE, SUPABASE_URL, SUPABASE_KEY } from '../r2-worker/worker.mjs';

const OWNER = 'f2e668a6-d31d-4468-8319-a87291f6fe2f';
const OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ORIGIN = 'https://zhengjialai7-a11y.github.io';
const SECRET = '0123456789abcdef'.repeat(4); // Test fixture, never a deployed secret.
const HOST = 'https://art-original-r2.example.test';
const hash = value => createHash('sha256').update(value).digest('hex');
const shaBuffer = value => Uint8Array.from(Buffer.from(hash(value), 'hex')).buffer;
async function bytes(value) {
  if (value instanceof ReadableStream) return Buffer.from(await new Response(value).arrayBuffer());
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw Error('Unexpected R2 value');
}

class FakeR2 {
  objects = new Map(); uploads = new Map(); creates = 0; writes = []; failNextPart = null; failNextComplete = null; failDelete = false;
  object(key, body, options = {}) {
    const data = Buffer.from(body), etag = createHash('md5').update(data).digest('hex');
    return { key, data, size: data.length, etag, httpEtag: `"${etag}"`, httpMetadata: options.httpMetadata || {}, customMetadata: options.customMetadata || {}, checksums: options.sha256 ? { sha256: shaBuffer(data) } : {}, json: async () => JSON.parse(data.toString()) };
  }
  async put(key, value, options = {}) {
    const data = await bytes(value), existing = this.objects.get(key), condition = options.onlyIf;
    if (condition?.get('If-None-Match') === '*' && existing) return null;
    if (condition?.get('If-Match') && condition.get('If-Match') !== existing?.etag) return null;
    if (options.sha256 && !Buffer.from(options.sha256).equals(Buffer.from(hash(data), 'hex'))) throw Error('put: BadDigest (10037)');
    const object = this.object(key, data, options); this.objects.set(key, object); this.writes.push(key); return object;
  }
  async head(key) { return this.objects.get(key) || null; }
  async get(key, options) {
    const object = this.objects.get(key); if (!object) return null;
    const data = options?.range ? object.data.subarray(options.range.offset, options.range.offset + options.range.length) : object.data;
    return { ...object, body: new Blob([data]).stream() };
  }
  async list({ prefix, cursor, limit = 1000 }) {
    const all = [...this.objects.values()].filter(object => object.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key));
    const start = Number(cursor || 0), objects = all.slice(start, start + limit), truncated = start + objects.length < all.length;
    return { objects, truncated, ...(truncated ? { cursor: String(start + objects.length) } : {}) };
  }
  async delete(keys) { if (this.failDelete) throw Error('temporary delete failure'); for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key); }
  async createMultipartUpload(key, options) {
    const uploadId = 'r2-private-' + (++this.creates); this.uploads.set(uploadId, { key, options, parts: new Map() });
    return this.resumeMultipartUpload(key, uploadId);
  }
  resumeMultipartUpload(key, uploadId) {
    const bucket = this;
    const lookup = () => { const upload = bucket.uploads.get(uploadId); if (!upload || upload.key !== key) throw Error('NoSuchUpload (10024)'); return upload; };
    return { uploadId,
      async uploadPart(partNumber, value) { if (bucket.failNextPart) { const error = bucket.failNextPart; bucket.failNextPart = null; throw error; } const upload = lookup(), data = await bytes(value), etag = createHash('md5').update(data).digest('hex'); upload.parts.set(partNumber, { data, etag }); return { partNumber, etag }; },
      async complete(parts) { if (bucket.failNextComplete) { const error = bucket.failNextComplete; bucket.failNextComplete = null; throw error; } const upload = lookup(); const data = Buffer.concat(parts.map(part => { const stored = upload.parts.get(part.partNumber); if (!stored || stored.etag !== part.etag) throw Error('InvalidPart (10025)'); return stored.data; })); const object = bucket.object(key, data, upload.options); bucket.objects.set(key, object); bucket.uploads.delete(uploadId); return object; },
      async abort() { bucket.uploads.delete(uploadId); }
    };
  }
}

function fixture() {
  let clock = Date.UTC(2026, 9, 13, 12), authCalls = [];
  const bucket = new FakeR2(), env = { BUCKET: bucket, R2_HMAC_SECRET: SECRET, ALLOWED_ORIGIN: ORIGIN };
  const gateway = createGateway({ now: () => clock, fetchImpl: async (url, options) => {
    authCalls.push({ url, options });
    const token = options.headers.authorization;
    return token === 'Bearer owner' ? Response.json({ id: OWNER }) : token === 'Bearer other' ? Response.json({ id: OTHER }) : Response.json({ error: 'expired' }, { status: 401 });
  } });
  async function request(path, { method = 'GET', body, token = 'owner', headers = {} } = {}) {
    const serialized = body && !Buffer.isBuffer(body) && !(body instanceof Uint8Array) ? JSON.stringify(body) : body;
    return gateway.fetch(new Request(HOST + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(serialized && typeof serialized === 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(serialized !== undefined ? { body: serialized } : {}) }), env);
  }
  const metadata = data => ({ sha256: hash(data), bytes: data.length, mime: 'image/jpeg' });
  async function initialize(data) { const response = await request('/v1/uploads', { method: 'POST', body: metadata(data) }); assert.equal(response.status, 200); return response.json(); }
  async function upload(data, initialization) {
    const state = initialization || await initialize(data), parts = [];
    for (let offset = 0, number = 1; offset < data.length; offset += PART_SIZE, number++) {
      const response = await request(`/v1/uploads/${state.uploadId}/parts/${number}?key=${encodeURIComponent(state.key)}`, { method: 'PUT', body: data.subarray(offset, Math.min(offset + PART_SIZE, data.length)) });
      assert.equal(response.status, 200); parts.push(await response.json());
    }
    return { state, parts };
  }
  async function complete(data, state, parts) { return request(`/v1/uploads/${state.uploadId}/complete`, { method: 'POST', body: { ...metadata(data), key: state.key, parts } }); }
  return { bucket, env, authCalls, request, initialize, upload, complete, metadata, advance: milliseconds => { clock += milliseconds; } };
}

test('gateway health is read-only and reveals no credentials', async () => {
  const f = fixture(), response = await f.request('/health', { token: null });
  assert.deepEqual(await response.json(), { service: 'art-original-r2', protocol: 1, partSize: PART_SIZE, configured: true });
  assert.equal(f.authCalls.length, 0); assert.equal(f.bucket.writes.length, 0);
  delete f.env.R2_HMAC_SECRET;
  assert.equal((await (await f.request('/health', { token: null })).json()).configured, false);
  assert.equal((await f.request('/v1/uploads', { method: 'POST', body: f.metadata(Buffer.from('raw')) })).status, 503);
});

test('every private operation validates JWT at the fixed Supabase project', async () => {
  const f = fixture(); f.env.SUPABASE_URL = 'https://evil.example';
  assert.equal((await f.request('/v1/uploads', { method: 'POST', body: f.metadata(Buffer.from('raw')), token: null })).status, 401);
  assert.equal((await f.request('/v1/uploads', { method: 'POST', body: f.metadata(Buffer.from('raw')), token: 'expired' })).status, 401);
  assert.equal(f.bucket.creates, 0);
  await f.initialize(Buffer.from('raw'));
  assert.ok(f.authCalls.every(call => call.url === SUPABASE_URL + '/auth/v1/user'));
  assert.ok(f.authCalls.every(call => call.options.headers.apikey === SUPABASE_KEY && call.options.redirect === 'error'));
});

test('private CORS rejects unapproved origins and public preflight permits reads only', async () => {
  const f = fixture(), metadata = f.metadata(Buffer.from('raw'));
  assert.equal((await f.request('/v1/uploads', { method: 'POST', body: metadata, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal(f.bucket.creates, 0);
  const response = await f.request('/v1/uploads', { method: 'OPTIONS', token: null, headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(response.status, 204); assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const denied = await f.request('/public/masters/x', { method: 'OPTIONS', token: null, headers: { 'Access-Control-Request-Method': 'PUT' } });
  assert.equal(denied.status, 405);
});

test('multipart resumes accepted parts and whole SHA-256 verified completion survives lost response', async () => {
  const f = fixture(), data = Buffer.alloc(PART_SIZE + 123, 17), initialized = await f.initialize(data);
  const firstResponse = await f.request(`/v1/uploads/${initialized.uploadId}/parts/1?key=${encodeURIComponent(initialized.key)}`, { method: 'PUT', body: data.subarray(0, PART_SIZE) });
  const first = await firstResponse.json(), resumed = await f.initialize(data);
  assert.equal(resumed.uploadId, initialized.uploadId); assert.deepEqual(resumed.parts, [first]); assert.equal(f.bucket.creates, 1);
  const second = await (await f.request(`/v1/uploads/${initialized.uploadId}/parts/2?key=${encodeURIComponent(initialized.key)}`, { method: 'PUT', body: data.subarray(PART_SIZE) })).json();
  const response = await f.complete(data, initialized, [first, second]); assert.equal(response.status, 200);
  const result = await response.json(), receipt = result.receipt;
  assert.equal(receipt.sha256, hash(data)); assert.equal(receipt.storage_origin, HOST); assert.equal(receipt.owner, OWNER); assert.equal(receipt.bytes, data.length);
  assert.equal(receipt.signature, createHmac('sha256', SECRET).update(receiptCanonical(receipt)).digest('hex'));
  assert.equal(hash(f.bucket.objects.get(initialized.key).data), hash(data));
  assert.deepEqual([...f.bucket.objects.keys()], [initialized.key]);
  const repeated = await f.complete(data, initialized, [first, second]); assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).receipt.sha256, hash(data));
  const again = await f.initialize(data); assert.equal(again.completed, true); assert.equal(f.bucket.creates, 1);
  const refresh = await f.request('/v1/receipts', { method: 'POST', body: { ...f.metadata(data), key: initialized.key } });
  assert.equal((await refresh.json()).signature, receipt.signature);
});

test('cross-account keys, encoded separators, private staging and malformed MIME are rejected', async () => {
  const f = fixture(), data = Buffer.from('original'), state = await f.initialize(data);
  assert.equal((await f.request('/v1/objects/' + state.key, { token: 'other' })).status, 403);
  assert.equal((await f.request('/v1/receipts', { method: 'POST', token: 'other', body: { ...f.metadata(data), key: state.key } })).status, 403);
  assert.equal((await f.request('/v1/objects/masters%2f' + OWNER + '/' + hash(data) + '.jpg')).status, 403);
  assert.equal((await f.request('/public/_staging/' + OWNER + '/' + state.uploadId, { token: null })).status, 403);
  assert.equal((await f.request('/v1/uploads', { method: 'POST', body: { ...f.metadata(data), mime: 'text/html' } })).status, 415);
});

test('part sizes, exact ordered part count, and stored ETags must agree', async () => {
  const f = fixture(), data = Buffer.alloc(PART_SIZE + 1, 3), state = await f.initialize(data);
  const partPath = `/v1/uploads/${state.uploadId}/parts/1?key=${encodeURIComponent(state.key)}`;
  assert.equal((await f.request(partPath, { method: 'PUT', body: data.subarray(0, 1) })).status, 400);
  assert.equal((await f.request(partPath, { method: 'PUT', body: data.subarray(0, PART_SIZE), headers: { 'Content-Length': '1' } })).status, 400);
  const { parts } = await f.upload(data, state);
  assert.equal((await f.complete(data, state, [parts[1], parts[0]])).status, 400);
  assert.equal((await f.complete(data, state, [parts[0]])).status, 400);
  assert.equal((await f.complete(data, state, [{ ...parts[0], etag: 'forged' }, parts[1]])).status, 409);
  assert.equal((await f.complete(data, state, parts)).status, 200);
});

test('claimed hash does not publish or sign altered bytes', async () => {
  const f = fixture(), original = Buffer.from('correct original'), altered = Buffer.from('altered original'), state = await f.initialize(original);
  assert.equal(original.length, altered.length);
  const part = await (await f.request(`/v1/uploads/${state.uploadId}/parts/1?key=${encodeURIComponent(state.key)}`, { method: 'PUT', body: altered })).json();
  const response = await f.complete(original, state, [part]); assert.equal(response.status, 422); assert.equal((await response.json()).code, 'ORIGINAL_SHA256_MISMATCH');
  assert.equal(await f.bucket.head(state.key), null);
  assert.equal((await f.request('/public/' + state.key, { token: null })).status, 404);
  assert.equal((await f.request('/v1/receipts', { method: 'POST', body: { ...f.metadata(original), key: state.key } })).status, 409);
  assert.ok([...f.bucket.objects.keys()].every(key => !key.startsWith('_staging/')));
  const fresh = await f.initialize(original); assert.notEqual(fresh.uploadId, state.uploadId); assert.deepEqual(fresh.parts, []);
  const corrected = await f.upload(original, fresh);
  assert.equal((await f.complete(original, fresh, corrected.parts)).status, 200);
});

test('raw final reads are immutable, support Range and public endpoint never writes', async () => {
  const f = fixture(), data = Buffer.from('abcdefghij'), { state, parts } = await f.upload(data); await f.complete(data, state, parts);
  const read = await f.request('/public/' + state.key, { token: null }); assert.equal(read.status, 200); assert.equal(read.headers.get('Access-Control-Allow-Origin'), '*'); assert.deepEqual(Buffer.from(await read.arrayBuffer()), data);
  const range = await f.request('/v1/objects/' + state.key, { headers: { Range: 'bytes=2-5' } });
  assert.equal(range.status, 206); assert.equal(range.headers.get('Content-Range'), 'bytes 2-5/10'); assert.equal(await range.text(), 'cdef');
  const suffix = await f.request('/public/' + state.key, { token: null, headers: { Range: 'bytes=-3' } }); assert.equal(await suffix.text(), 'hij');
  assert.equal((await f.request('/public/' + state.key, { token: null, headers: { Range: 'bytes=100-' } })).status, 416);
  const head = await f.request('/public/' + state.key, { method: 'HEAD', token: null }); assert.equal(head.headers.get('Content-Length'), '10'); assert.equal(await head.text(), '');
  assert.equal((await f.request('/public/' + state.key, { token: null, headers: { 'If-None-Match': head.headers.get('ETag') } })).status, 304);
  const before = f.bucket.writes.length;
  for (const method of ['PUT', 'POST', 'DELETE']) assert.equal((await f.request('/public/' + state.key, { method, token: null })).status, 405);
  assert.equal(f.bucket.writes.length, before);
});

test('metadata-only objects and an immutable conflicting object cannot become verified', async () => {
  const f = fixture(), data = Buffer.from('original'), key = `masters/${OWNER}/${hash(data)}.jpg`;
  await f.bucket.put(key, data, { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: { owner: OWNER, sha256: hash(data) } });
  assert.equal((await f.request('/public/' + key, { token: null })).status, 409);
  assert.equal((await f.request('/v1/uploads', { method: 'POST', body: f.metadata(data) })).status, 409);
  assert.deepEqual(f.bucket.objects.get(key).data, data);
});

test('transient part or complete errors retain sessions; NoSuchUpload recreates them', async () => {
  const f = fixture(), data = Buffer.from('original'), state = await f.initialize(data);
  const partPath = `/v1/uploads/${state.uploadId}/parts/1?key=${encodeURIComponent(state.key)}`;
  f.bucket.failNextPart = Error('ServiceUnavailable (10043)');
  assert.equal((await f.request(partPath, { method: 'PUT', body: data })).status, 503);
  assert.equal((await f.initialize(data)).uploadId, state.uploadId);
  const part = await (await f.request(partPath, { method: 'PUT', body: data })).json();
  f.bucket.failNextComplete = Error('TooManyRequests (10058)');
  assert.equal((await f.complete(data, state, [part])).status, 503);
  assert.equal((await f.initialize(data)).uploadId, state.uploadId);
  f.bucket.uploads.clear();
  assert.equal((await f.request(partPath, { method: 'PUT', body: data })).status, 410);
  assert.notEqual((await f.initialize(data)).uploadId, state.uploadId);
});

test('old sessions rotate before R2 expiry and incompatible metadata cannot overwrite index', async () => {
  const f = fixture(), data = Buffer.from('original'), state = await f.initialize(data);
  assert.equal((await f.request('/v1/uploads', { method: 'POST', body: { ...f.metadata(data), bytes: data.length + 1 } })).status, 409);
  assert.equal(f.bucket.creates, 1);
  f.advance(6 * 24 * 60 * 60 * 1000);
  const refreshed = await f.initialize(data); assert.notEqual(refreshed.uploadId, state.uploadId); assert.equal(f.bucket.uploads.size, 1);
});

test('concurrent creates converge using conditional session writes', async () => {
  const f = fixture(), data = Buffer.from('original');
  const states = await Promise.all([f.initialize(data), f.initialize(data)]);
  assert.equal(states[0].uploadId, states[1].uploadId); assert.equal(f.bucket.uploads.size, 1);
});

test('cleanup interruption keeps final proof and retry completion works', async () => {
  const f = fixture(), data = Buffer.from('original'), { state, parts } = await f.upload(data); f.bucket.failDelete = true;
  assert.equal((await f.complete(data, state, parts)).status, 200);
  assert.equal((await f.complete(data, state, parts)).status, 200);
  assert.equal((await f.request('/public/' + state.key, { token: null })).status, 200);
});

test('bounded metadata and byte ceilings reject oversized originals before allocating', async () => {
  const f = fixture(), data = Buffer.from('original');
  assert.equal((await f.request('/v1/uploads', { method: 'POST', body: { ...f.metadata(data), bytes: 5 * 1024 ** 3 + 1 } })).status, 413);
  f.env.MAX_ORIGINAL_BYTES = '5';
  assert.equal((await f.request('/v1/uploads', { method: 'POST', body: f.metadata(data) })).status, 413);
  assert.equal(f.bucket.creates, 0);
});

test('Workers FixedLengthStream promotion streams and validates the original', async () => {
  const original = globalThis.FixedLengthStream;
  globalThis.FixedLengthStream = class {
    constructor(expected) {
      let seen = 0;
      const stream = new TransformStream({ transform(chunk, controller) { seen += chunk.byteLength; if (seen > expected) throw Error('too many bytes'); controller.enqueue(chunk); }, flush() { if (seen !== expected) throw Error('too few bytes'); } });
      this.readable = stream.readable; this.writable = stream.writable;
    }
  };
  try {
    const f = fixture(), data = Buffer.from('original streamed bytes'), { state, parts } = await f.upload(data);
    assert.equal((await f.complete(data, state, parts)).status, 200);
    assert.equal(hash(f.bucket.objects.get(state.key).data), hash(data));
  } finally { if (original === undefined) delete globalThis.FixedLengthStream; else globalThis.FixedLengthStream = original; }
});

test('conditional promotion cancels an unconsumed stream when another verified writer wins', { timeout: 2000 }, async () => {
  const original = globalThis.FixedLengthStream;
  globalThis.FixedLengthStream = class {
    constructor() { const stream = new TransformStream(); this.readable = stream.readable; this.writable = stream.writable; }
  };
  try {
    const f = fixture(), data = Buffer.from('original streamed bytes'), { state, parts } = await f.upload(data), put = f.bucket.put.bind(f.bucket);
    f.bucket.put = async (key, value, options = {}) => {
      if (key === state.key) { const object = f.bucket.object(key, data, options); f.bucket.objects.set(key, object); return null; }
      return put(key, value, options);
    };
    assert.equal((await f.complete(data, state, parts)).status, 200);
  } finally { if (original === undefined) delete globalThis.FixedLengthStream; else globalThis.FixedLengthStream = original; }
});
