// Original bytes only: multipart staging is private and the final key is SHA-256 checked by R2.
export const SUPABASE_URL = 'https://otaokoencpoanxjjuqzv.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_hA9UHbP834axMbvdRRbwyA_4dUTU2-B';
export const PART_SIZE = 8 * 1024 * 1024;
export const MAX_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_ORIGIN = 'https://zhengjialai7-a11y.github.io';
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const KEY_PATTERN = new RegExp(`^masters/(${UUID})/([a-f0-9]{64})\\.(jpg|png|webp)$`);
const UPLOAD_PATTERN = new RegExp(`^(?:${UUID}|complete-[a-f0-9]{64})$`);
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const EXPIRES_MS = 6 * 24 * 60 * 60 * 1000;
const JSON_LIMIT = 64 * 1024;
const validSecret = env => typeof env.R2_HMAC_SECRET === 'string' && /^[a-f0-9]{64}$/.test(env.R2_HMAC_SECRET);

class GatewayError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new GatewayError(status, code, message); };
const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
const hashBytes = hash => Uint8Array.from(hash.match(/../g), x => Number.parseInt(x, 16)).buffer;
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const sessionKey = (owner, hash) => `_uploads/${owner}/${hash}.json`;
const partKey = (session, number) => `_uploads/${session.owner}/${session.sha256}/${session.id}/${number}.json`;
const missingUpload = error => /NoSuchUpload|10024/i.test(String(error?.message));

function inputMetadata(input, owner, env) {
  if (!input || !/^[a-f0-9]{64}$/.test(input.sha256 || '')) fail(400, 'INVALID_SHA256', '母图 SHA-256 无效');
  const limit = Number(env.MAX_ORIGINAL_BYTES || MAX_BYTES);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BYTES) fail(503, 'CONFIGURATION_ERROR', '母图容量上限配置无效');
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > limit) fail(413, 'ORIGINAL_TOO_LARGE', '母图超出网关容量上限');
  if (!Object.hasOwn(MIME_EXT, input.mime)) fail(415, 'INVALID_MIME', '仅支持原始 JPEG、PNG、WebP');
  const key = `masters/${owner}/${input.sha256}.${MIME_EXT[input.mime]}`;
  if (input.key !== undefined && input.key !== key) fail(403, 'INVALID_KEY', '母图路径或账号不匹配');
  return { owner, key, sha256: input.sha256, bytes: input.bytes, mime: input.mime };
}

function keyMetadata(key, owner) {
  const match = KEY_PATTERN.exec(key);
  if (!match || (owner && match[1] !== owner)) fail(403, 'INVALID_KEY', '母图路径或账号不匹配');
  return { owner: match[1], sha256: match[2], mime: { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[match[3]], key };
}

function checksumHex(object) {
  const checksum = object?.checksums?.sha256;
  return checksum instanceof ArrayBuffer || ArrayBuffer.isView(checksum)
    ? hex(checksum instanceof ArrayBuffer ? checksum : checksum.buffer.slice(checksum.byteOffset, checksum.byteOffset + checksum.byteLength))
    : null;
}

function verifiedObject(object, metadata) {
  return !!object && object.key === metadata.key && Number.isSafeInteger(object.size) && object.size > 0
    && (metadata.bytes === undefined || object.size === metadata.bytes)
    && checksumHex(object) === metadata.sha256
    && object.httpMetadata?.contentType === metadata.mime
    && object.customMetadata?.owner === metadata.owner
    && object.customMetadata?.sha256 === metadata.sha256;
}

async function readJson(request) {
  const declared = request.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > JSON_LIMIT)) fail(413, 'JSON_TOO_LARGE', '请求内容过大');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'INVALID_JSON', '请求内容不能为空');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > JSON_LIMIT) { await reader.cancel(); fail(413, 'JSON_TOO_LARGE', '请求内容过大'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { fail(400, 'INVALID_JSON', '请求 JSON 无效'); }
}

async function boundedPart(request, expected) {
  const declared = request.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) !== expected)) fail(400, 'PART_SIZE_MISMATCH', '上传分段字节数不匹配');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'EMPTY_PART', '上传分段不能为空');
  // Bound memory to one 8 MiB part; the full original is never buffered.
  const bytes = new Uint8Array(expected); let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      if (length + value.byteLength > expected) { await reader.cancel(); fail(400, 'PART_SIZE_MISMATCH', '上传分段字节数不匹配'); }
      bytes.set(value, length); length += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  if (length !== expected) fail(400, 'PART_SIZE_MISMATCH', '上传分段字节数不匹配');
  return bytes;
}

async function storedSession(bucket, metadata) {
  const object = await bucket.get(sessionKey(metadata.owner, metadata.sha256));
  if (!object) return null;
  const session = await object.json();
  if (session.version !== 1 || session.owner !== metadata.owner || session.key !== metadata.key
    || session.sha256 !== metadata.sha256 || session.bytes !== metadata.bytes || session.mime !== metadata.mime
    || !new RegExp(`^${UUID}$`).test(session.id || '') || !Number.isSafeInteger(session.createdAt)
    || session.stagingKey !== `_staging/${metadata.owner}/${session.id}` || typeof session.r2UploadId !== 'string') {
    fail(409, 'UPLOAD_METADATA_CONFLICT', '已有上传记录与母图信息不一致');
  }
  return { session, etag: object.etag };
}

async function savedParts(bucket, session) {
  const count = Math.ceil(session.bytes / PART_SIZE);
  const prefix = `_uploads/${session.owner}/${session.sha256}/${session.id}/`, parts = [];
  let cursor;
  // List acknowledgement metadata in pages instead of one subrequest for every part.
  do {
    const page = await bucket.list({ prefix, limit: 1000, include: ['customMetadata'], ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) {
      const part = { partNumber: Number(object.customMetadata?.partNumber), etag: object.customMetadata?.etag };
      if (!Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > count || object.key !== partKey(session, part.partNumber)
        || typeof part.etag !== 'string' || !part.etag || part.etag.length > 160 || /[\x00-\x1f\x7f]/.test(part.etag)) fail(409, 'PART_RECORD_CONFLICT', '上传分段记录无效');
      parts.push(part);
    }
    if (parts.length > count) fail(409, 'PART_RECORD_CONFLICT', '上传分段记录无效');
    if (page.truncated && (!page.cursor || page.cursor === cursor)) fail(503, 'STORAGE_UNAVAILABLE', '上传分段列表暂时不可用');
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return parts.sort((left, right) => left.partNumber - right.partNumber);
}

async function cleanSession(bucket, session, includeIndex = true) {
  const keys = [session.stagingKey, ...Array.from({ length: Math.ceil(session.bytes / PART_SIZE) }, (_, index) => partKey(session, index + 1))];
  if (includeIndex) keys.push(sessionKey(session.owner, session.sha256));
  for (let start = 0; start < keys.length; start += 1000) await bucket.delete(keys.slice(start, start + 1000));
}

async function expireSession(bucket, prior) {
  // Conditional replacement cannot invalidate a newer session created by another client.
  await bucket.put(sessionKey(prior.session.owner, prior.session.sha256), JSON.stringify({ ...prior.session, createdAt: 0 }), { onlyIf: new Headers({ 'If-Match': prior.etag }), httpMetadata: { contentType: 'application/json' } });
}

export function receiptCanonical(receipt) {
  return ['r2-v1', receipt.owner, receipt.storage_origin, receipt.path, receipt.sha256, String(receipt.bytes), receipt.mime, receipt.etag, String(receipt.issued_at)].join('\n');
}

async function signReceipt(object, metadata, origin, env, now) {
  if (!verifiedObject(object, metadata)) fail(409, 'ORIGINAL_NOT_VERIFIED', '母图尚未完成原始字节校验');
  if (!validSecret(env)) fail(503, 'CONFIGURATION_ERROR', '存储签名服务尚未配置');
  if (typeof object.etag !== 'string' || !object.etag || object.etag.length > 160 || /[\x00-\x1f\x7f]/.test(object.etag)) fail(409, 'INVALID_ETAG', '母图存储校验标识无效');
  const receipt = { owner: metadata.owner, storage_origin: origin, path: metadata.key, sha256: metadata.sha256, bytes: object.size, mime: metadata.mime, etag: object.etag, issued_at: Math.floor(now() / 1000) };
  const signingKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.R2_HMAC_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  receipt.signature = hex(await crypto.subtle.sign('HMAC', signingKey, new TextEncoder().encode(receiptCanonical(receipt))));
  return receipt;
}

async function promoteOriginal(bucket, session) {
  const staged = await bucket.get(session.stagingKey);
  if (!staged?.body || staged.size !== session.bytes) fail(409, 'ORIGINAL_SIZE_MISMATCH', '母图完整字节数不匹配');
  const options = { sha256: hashBytes(session.sha256), onlyIf: new Headers({ 'If-None-Match': '*' }), httpMetadata: { contentType: session.mime, cacheControl: 'public, max-age=31536000, immutable' }, customMetadata: { owner: session.owner, sha256: session.sha256 } };
  let object;
  try {
    // Native R2 bodies retain their length. FixedLengthStream additionally verifies it in Workers.
    if (typeof FixedLengthStream === 'function') {
      const fixed = new FixedLengthStream(staged.size), abort = new AbortController();
      const pumping = staged.body.pipeTo(fixed.writable, { signal: abort.signal });
      // Attach a handler immediately: conditional rejection can stop consuming the stream.
      const pumpResult = pumping.then(() => null, error => error);
      try {
        object = await bucket.put(session.key, fixed.readable, options);
        if (object) { const pumpError = await pumpResult; if (pumpError) throw pumpError; }
        // If R2 rejects the condition before reading, an in-flight pipe write can be
        // backpressured forever. Cancel the readable too; do not await that unused pump.
      } finally {
        abort.abort();
        if (!object) { try { await fixed.readable.cancel(); } catch {} }
      }
    } else object = await bucket.put(session.key, staged.body, options);
  } catch (error) {
    if (/BadDigest|10037|checksum|digest/i.test(String(error.message))) fail(422, 'ORIGINAL_SHA256_MISMATCH', '母图完整 SHA-256 校验失败，原图和上传记录已保留');
    throw error;
  }
  const result = object || await bucket.head(session.key);
  if (!verifiedObject(result, session)) fail(409, 'IMMUTABLE_OBJECT_CONFLICT', '已有母图与上传原始字节不一致，未覆盖');
  return result;
}

function cors(response, request, publicRead, env) {
  const headers = new Headers(response.headers), origin = request.headers.get('Origin');
  if (publicRead) headers.set('Access-Control-Allow-Origin', '*');
  else if (origin === (env.ALLOWED_ORIGIN || DEFAULT_ORIGIN)) { headers.set('Access-Control-Allow-Origin', origin); headers.append('Vary', 'Origin'); }
  headers.set('Access-Control-Expose-Headers', 'ETag, Content-Length, Content-Range, Accept-Ranges');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function serveOriginal(request, bucket, key, owner) {
  const metadata = keyMetadata(key, owner), head = await bucket.head(key);
  if (!head) fail(404, 'ORIGINAL_NOT_FOUND', '母图不存在');
  if (!verifiedObject(head, metadata)) fail(409, 'ORIGINAL_NOT_VERIFIED', '母图尚未完成原始字节校验');
  const headers = new Headers({ 'ETag': head.httpEtag || `"${head.etag}"`, 'Content-Type': metadata.mime, 'Content-Length': String(head.size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable' });
  if (request.headers.get('If-None-Match')?.split(',').some(value => value.trim() === headers.get('ETag') || value.trim() === '*')) return new Response(null, { status: 304, headers });
  if (request.method === 'HEAD') return new Response(null, { headers });
  let range;
  if (request.headers.has('Range') && (!request.headers.has('If-Range') || request.headers.get('If-Range') === headers.get('ETag'))) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range'));
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${head.size}` } });
    const start = match[1] ? Number(match[1]) : Math.max(0, head.size - Number(match[2]));
    const end = match[1] ? (match[2] ? Math.min(Number(match[2]), head.size - 1) : head.size - 1) : head.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= head.size || (!match[1] && Number(match[2]) === 0)) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${head.size}` } });
    range = { offset: start, length: end - start + 1 };
    headers.set('Content-Range', `bytes ${start}-${end}/${head.size}`); headers.set('Content-Length', String(range.length));
  }
  const object = await bucket.get(key, range ? { range } : undefined);
  if (!object?.body || !verifiedObject(object, metadata)) fail(409, 'ORIGINAL_NOT_VERIFIED', '母图存储校验状态已变化');
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

export function createGateway({ fetchImpl = fetch, now = Date.now } = {}) {
  async function authenticate(request) {
    const authorization = request.headers.get('Authorization');
    if (!authorization || !/^Bearer [^\s]{1,12000}$/.test(authorization)) fail(401, 'AUTH_REQUIRED', '请先登录收藏队列');
    let response;
    try { response = await fetchImpl(`${SUPABASE_URL}/auth/v1/user`, { headers: { authorization, apikey: SUPABASE_KEY }, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { fail(502, 'AUTH_UNAVAILABLE', '账号验证服务暂时不可用，请稍后重试'); }
    if ([401, 403].includes(response.status)) fail(401, 'AUTH_EXPIRED', '账号登录已失效，请重新登录');
    if (!response.ok) fail(502, 'AUTH_UNAVAILABLE', '账号验证服务暂时不可用，请稍后重试');
    let user; try { user = await response.json(); } catch { fail(502, 'AUTH_UNAVAILABLE', '账号验证服务返回无效'); }
    if (!new RegExp(`^${UUID}$`).test(user.id || '')) fail(401, 'AUTH_INVALID', '账号验证失败');
    return user.id;
  }

  return { async fetch(request, env) {
    const url = new URL(request.url), publicRead = url.pathname.startsWith('/public/');
    try {
      if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') fail(400, 'HTTPS_REQUIRED', '存储服务需要 HTTPS');
      if (request.method === 'GET' && url.pathname === '/health') return cors(json({ service: 'art-original-r2', protocol: 1, partSize: PART_SIZE, configured: !!env.BUCKET && validSecret(env) }), request, false, env);
      const origin = request.headers.get('Origin');
      if (!publicRead && origin && origin !== (env.ALLOWED_ORIGIN || DEFAULT_ORIGIN)) fail(403, 'ORIGIN_NOT_ALLOWED', '当前网页来源未授权');
      if (request.method === 'OPTIONS') {
        const methods = publicRead ? 'GET, HEAD, OPTIONS' : 'GET, HEAD, POST, PUT, OPTIONS';
        const requested = request.headers.get('Access-Control-Request-Method');
        if (requested && !methods.split(', ').includes(requested)) fail(405, 'METHOD_NOT_ALLOWED', '此操作不受支持');
        return cors(new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': methods, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Content-Length, Range, If-None-Match, If-Range', 'Access-Control-Max-Age': '600' } }), request, publicRead, env);
      }
      if (!env.BUCKET) fail(503, 'CONFIGURATION_ERROR', '母图存储服务尚未配置');
      // Reject all encoded separators and dot segments before any key reaches the binding.
      if (/%(?:2f|5c|2e)/i.test(url.pathname) || url.pathname.includes('\\')) fail(403, 'INVALID_PATH', '母图路径无效');
      if (publicRead) {
        if (!['GET', 'HEAD'].includes(request.method)) fail(405, 'METHOD_NOT_ALLOWED', '公开母图接口只允许读取');
        return cors(await serveOriginal(request, env.BUCKET, url.pathname.slice('/public/'.length), null), request, true, env);
      }
      const owner = await authenticate(request);
      if (url.pathname.startsWith('/v1/objects/')) {
        if (!['GET', 'HEAD'].includes(request.method)) fail(405, 'METHOD_NOT_ALLOWED', '母图接口只允许读取');
        return cors(await serveOriginal(request, env.BUCKET, url.pathname.slice('/v1/objects/'.length), owner), request, false, env);
      }
      if (request.method === 'POST' && url.pathname === '/v1/receipts') {
        const metadata = inputMetadata(await readJson(request), owner, env);
        return cors(json(await signReceipt(await env.BUCKET.head(metadata.key), metadata, url.origin, env, now)), request, false, env);
      }
      if (request.method === 'POST' && url.pathname === '/v1/uploads') {
        if (!validSecret(env)) fail(503, 'CONFIGURATION_ERROR', '存储签名服务尚未配置');
        const metadata = inputMetadata(await readJson(request), owner, env), existing = await env.BUCKET.head(metadata.key);
        if (existing) {
          const receipt = await signReceipt(existing, metadata, url.origin, env, now);
          return cors(json({ uploadId: `complete-${metadata.sha256}`, key: metadata.key, partSize: PART_SIZE, completed: true, parts: [], receipt }), request, false, env);
        }
        let prior = await storedSession(env.BUCKET, metadata);
        if (prior && now() - prior.session.createdAt < EXPIRES_MS) return cors(json({ uploadId: prior.session.id, key: metadata.key, partSize: PART_SIZE, parts: await savedParts(env.BUCKET, prior.session) }), request, false, env);
        const id = crypto.randomUUID(), stagingKey = `_staging/${owner}/${id}`;
        const upload = await env.BUCKET.createMultipartUpload(stagingKey, { httpMetadata: { contentType: metadata.mime }, customMetadata: { owner, sha256: metadata.sha256 } });
        const session = { version: 1, ...metadata, id, stagingKey, r2UploadId: upload.uploadId, createdAt: now() };
        const result = await env.BUCKET.put(sessionKey(owner, metadata.sha256), JSON.stringify(session), { onlyIf: new Headers(prior ? { 'If-Match': prior.etag } : { 'If-None-Match': '*' }), httpMetadata: { contentType: 'application/json' } });
        if (!result) {
          try { await upload.abort(); } catch {}
          const winner = await storedSession(env.BUCKET, metadata);
          if (!winner) fail(409, 'UPLOAD_CREATE_RACE', '上传初始化已变化，请重试');
          return cors(json({ uploadId: winner.session.id, key: metadata.key, partSize: PART_SIZE, parts: await savedParts(env.BUCKET, winner.session) }), request, false, env);
        }
        if (prior) { try { await env.BUCKET.resumeMultipartUpload(prior.session.stagingKey, prior.session.r2UploadId).abort(); } catch {} try { await cleanSession(env.BUCKET, prior.session, false); } catch {} }
        return cors(json({ uploadId: id, key: metadata.key, partSize: PART_SIZE, parts: [] }), request, false, env);
      }
      const partRoute = /^\/v1\/uploads\/([^/]+)\/parts\/(\d+)$/.exec(url.pathname);
      if (partRoute && request.method === 'PUT') {
        const [, id, numberText] = partRoute, partNumber = Number(numberText), key = url.searchParams.get('key');
        if (!UPLOAD_PATTERN.test(id) || !key) fail(400, 'INVALID_UPLOAD', '上传记录无效');
        const meta = keyMetadata(key, owner), index = await env.BUCKET.get(sessionKey(owner, meta.sha256));
        if (!index) fail(410, 'UPLOAD_EXPIRED', '上传记录已过期，请重新开始上传');
        const raw = await index.json(), metadata = inputMetadata(raw, owner, env), prior = await storedSession(env.BUCKET, metadata);
        if (!prior || prior.session.id !== id || key !== prior.session.key || now() - prior.session.createdAt >= EXPIRES_MS) fail(410, 'UPLOAD_EXPIRED', '上传记录已变化，请重新开始上传');
        const session = prior.session, count = Math.ceil(session.bytes / PART_SIZE);
        if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > count) fail(400, 'INVALID_PART', '上传分段序号无效');
        const body = await boundedPart(request, partNumber === count ? session.bytes - (count - 1) * PART_SIZE : PART_SIZE);
        if (await env.BUCKET.head(session.key)) fail(409, 'UPLOAD_ALREADY_COMPLETE', '母图已完成上传，请重新核对完成记录');
        let part;
        try { part = await env.BUCKET.resumeMultipartUpload(session.stagingKey, session.r2UploadId).uploadPart(partNumber, body); }
        catch (error) { if (!missingUpload(error)) throw error; await expireSession(env.BUCKET, prior); fail(410, 'UPLOAD_EXPIRED', '上传分段会话已失效，请重新开始上传'); }
        await env.BUCKET.put(partKey(session, partNumber), JSON.stringify(part), { httpMetadata: { contentType: 'application/json' }, customMetadata: { partNumber: String(part.partNumber), etag: part.etag } });
        return cors(json(part), request, false, env);
      }
      const completeRoute = /^\/v1\/uploads\/([^/]+)\/complete$/.exec(url.pathname);
      if (completeRoute && request.method === 'POST') {
        const id = completeRoute[1]; if (!UPLOAD_PATTERN.test(id)) fail(400, 'INVALID_UPLOAD', '上传记录无效');
        const input = await readJson(request), metadata = inputMetadata(input, owner, env), existing = await env.BUCKET.head(metadata.key);
        if (existing) return cors(json({ key: metadata.key, etag: existing.etag, bytes: existing.size, receipt: await signReceipt(existing, metadata, url.origin, env, now) }), request, false, env);
        const prior = await storedSession(env.BUCKET, metadata);
        if (!prior || prior.session.id !== id || now() - prior.session.createdAt >= EXPIRES_MS) fail(410, 'UPLOAD_EXPIRED', '上传记录已过期，请重新开始上传');
        const session = prior.session, parts = input.parts, count = Math.ceil(metadata.bytes / PART_SIZE);
        if (!Array.isArray(parts) || parts.length !== count || parts.some((part, index) => part?.partNumber !== index + 1 || typeof part.etag !== 'string' || !part.etag || part.etag.length > 160 || /[\x00-\x1f\x7f]/.test(part.etag))) fail(400, 'INVALID_PARTS', '上传分段需要完整且按序排列');
        const saved = await savedParts(env.BUCKET, session);
        if (saved.length !== count || saved.some((part, index) => part.partNumber !== parts[index].partNumber || part.etag !== parts[index].etag)) fail(409, 'PART_RECEIPT_MISMATCH', '上传分段校验记录不匹配');
        if (!(await env.BUCKET.head(session.stagingKey))) {
          try { await env.BUCKET.resumeMultipartUpload(session.stagingKey, session.r2UploadId).complete(parts); }
          catch (error) { if (!(await env.BUCKET.head(session.stagingKey))) { if (!missingUpload(error)) throw error; await expireSession(env.BUCKET, prior); fail(410, 'UPLOAD_EXPIRED', '上传会话已失效，请重新开始上传'); } }
        }
        let object;
        try { object = await promoteOriginal(env.BUCKET, session); }
        catch (error) {
          // A failed full-file digest is not a valid resume point. Clear proven-bad private
          // bytes, preserve the expired session marker, and let the next retry start fresh.
          if (error instanceof GatewayError && ['ORIGINAL_SHA256_MISMATCH', 'ORIGINAL_SIZE_MISMATCH'].includes(error.code)) {
            await expireSession(env.BUCKET, prior);
            try { await cleanSession(env.BUCKET, session, false); } catch { /* Lifecycle/next create can remove failed private bytes. */ }
          }
          throw error;
        }
        const receipt = await signReceipt(object, metadata, url.origin, env, now);
        try { await cleanSession(env.BUCKET, session); } catch { /* A verified immutable final object survives any cleanup failure. */ }
        return cors(json({ key: metadata.key, etag: object.etag, bytes: object.size, receipt }), request, false, env);
      }
      fail(404, 'ROUTE_NOT_FOUND', '存储接口不存在');
    } catch (error) {
      const known = error instanceof GatewayError;
      // Storage exception messages may contain keys/account details; do not return them.
      return cors(json({ error: known ? error.message : '存储服务暂时不可用，请重试；原图和进度已保留', code: known ? error.code : 'STORAGE_UNAVAILABLE' }, known ? error.status : 503), request, publicRead, env);
    }
  } };
}

export default createGateway();
