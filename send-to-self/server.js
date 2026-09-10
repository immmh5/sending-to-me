#!/usr/bin/env node
'use strict';

/*
  "أرسل لنفسي" — Send-to-Self
  A tiny personal inbox: text, images, files.
  One shared password, no accounts.
  Zero dependencies (Node.js standard library only).
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const ITEMS_FILE = path.join(DATA_DIR, 'items.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const HOST = '0.0.0.0';
const MAX_BODY = 1024 * 1024 * 1024;          // 1 GB upload limit
const MAX_JSON = 1024 * 1024;                 // 1 MB json limit
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || '12345';

/* ---------------- data layer ---------------- */

function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    const salt = crypto.randomBytes(16).toString('hex');
    const cfg = {
      salt,
      passwordHash: hashPassword(DEFAULT_PASSWORD, salt),
      secret: crypto.randomBytes(32).toString('hex'),
      createdAt: Date.now(),
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    console.log('Created new config with default password: ' + DEFAULT_PASSWORD);
  }
  if (!fs.existsSync(ITEMS_FILE)) fs.writeFileSync(ITEMS_FILE, '[]');
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 64).toString('hex');
}

function verifyPassword(pw, cfg) {
  try {
    const h = hashPassword(pw, cfg.salt);
    const a = Buffer.from(h, 'hex');
    const b = Buffer.from(cfg.passwordHash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

function loadItems() {
  try { return JSON.parse(fs.readFileSync(ITEMS_FILE, 'utf8')); }
  catch (e) { return []; }
}

function saveItems(items) {
  fs.writeFileSync(ITEMS_FILE, JSON.stringify(items, null, 2));
}

/* ---------------- auth tokens ---------------- */

function makeToken(secret) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function checkToken(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const i = token.lastIndexOf('.');
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof d.exp === 'number' && d.exp > Date.now();
  } catch (e) { return false; }
}

function getAuth(req, url) {
  let token = null;
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) token = h.slice(7);
  if (!token) token = url.searchParams.get('token');
  return token;
}

/* ---------------- login rate limit ---------------- */

const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const WINDOW = 10 * 60 * 1000;
  const MAX = 15;
  if (attempts.size > 10000) { // prune
    for (const [k, v] of attempts) if (now - v.first > WINDOW) attempts.delete(k);
  }
  const rec = attempts.get(ip);
  if (!rec || now - rec.first > WINDOW) {
    attempts.set(ip, { first: now, count: 1 });
    return false;
  }
  rec.count++;
  return rec.count > MAX;
}
function clearAttempts(ip) { attempts.delete(ip); }

/* ---------------- helpers ---------------- */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Disposition',
};
function withCors(headers) { return Object.assign({}, CORS_HEADERS, headers || {}); }

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, withCors({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }));
  res.end(body);
}

function readBody(req, limit, cb) {
  const chunks = [];
  let size = 0;
  let finished = false;
  const finish = (err, buf) => { if (!finished) { finished = true; cb(err, buf); } };
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { req.destroy(); return finish(new Error('too large'), null); }
    chunks.push(c);
  });
  req.on('end', () => finish(null, Buffer.concat(chunks)));
  req.on('error', (e) => finish(e, null));
}

function readJson(req, cb) {
  readBody(req, MAX_JSON, (err, buf) => {
    if (err || !buf) return cb(null);
    try { cb(JSON.parse(buf.toString('utf8'))); }
    catch (e) { cb(null); }
  });
}

/* ---------------- multipart ---------------- */

function parseDisposition(line) {
  const result = { name: null, filename: null };
  const parts = line.split(';');
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i].trim();
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const k = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (k === 'name') result.name = v;
    else if (k === 'filename') result.filename = v;
    else if (k === 'filename*') {
      const m = /UTF-8''(.*)$/i.exec(v);
      if (m) { try { result.filename = decodeURIComponent(m[1]); } catch (e) {} }
    }
  }
  return result;
}

function parseMultipart(buffer, boundary) {
  const parts = [];
  const delim = Buffer.from('--' + boundary);
  let idx = buffer.indexOf(delim);
  while (idx !== -1) {
    const next = buffer.indexOf(delim, idx + delim.length);
    if (next === -1) break;
    let start = idx + delim.length;
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    let end = next;
    if (end >= 2 && buffer[end - 2] === 13 && buffer[end - 1] === 10) end -= 2;
    const seg = buffer.slice(start, end);
    let headerEnd = seg.indexOf(Buffer.from('\r\n\r\n'));
    let headerLen = 4;
    if (headerEnd === -1) {
      headerEnd = seg.indexOf(Buffer.from('\n\n'));
      headerLen = 2;
    }
    if (headerEnd !== -1) {
      const headerText = seg.slice(0, headerEnd).toString('utf8');
      const body = seg.slice(headerEnd + headerLen);
      let name = null, filename = null, contentType = null;
      const cd = /content-disposition\s*:\s*form-data\s*;/i.exec(headerText);
      if (cd) {
        const line = headerText.slice(cd.index);
        const nl = line.search(/\r?\n/);
        const d = parseDisposition(nl === -1 ? line : line.slice(0, nl));
        name = d.name; filename = d.filename;
      }
      const ct = /content-type\s*:\s*([^\r\n]+)/i.exec(headerText);
      if (ct) contentType = ct[1].trim();
      parts.push({ name, filename, contentType, data: body });
    }
    idx = next;
  }
  return parts;
}

/* ---------------- mime / ext ---------------- */

function sniffMime(ct, data, filename) {
  if (ct && ct !== 'application/octet-stream') return ct.toLowerCase().split(';')[0].trim();
  if (data && data.length >= 4) {
    const b = data;
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (data.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
    if (b[0] === 0x50 && b[1] === 0x4B) return 'application/zip';
  }
  const byExt = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv',
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.apk': 'application/vnd.android.package-archive',
  };
  const m2 = /\.([A-Za-z0-9]{1,10})$/.exec(String(filename || '').toLowerCase());
  if (m2 && byExt['.' + m2[1]]) return byExt['.' + m2[1]];
  return 'application/octet-stream';
}

function extFromMime(mime) {
  const map = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
    'application/pdf': '.pdf', 'text/plain': '.txt', 'video/mp4': '.mp4',
    'audio/mpeg': '.mp3', 'application/zip': '.zip',
  };
  return map[mime] || '.bin';
}

function contentDisposition(filename, download) {
  const type = download ? 'attachment' : 'inline';
  const ascii = String(filename).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'file';
  const enc = encodeURIComponent(String(filename));
  return type + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + enc;
}

/* ---------------- handlers ---------------- */

function sendIndex(res) {
  if (!fs.existsSync(INDEX_FILE)) return json(res, 500, { error: 'index.html missing' });
  res.writeHead(200, withCors({ 'Content-Type': 'text/html; charset=utf-8' }));
  fs.createReadStream(INDEX_FILE).pipe(res);
}

function handleLogin(req, res, cfg) {
  const ip = req.socket.remoteAddress || '?';
  if (tooMany(ip)) return json(res, 429, { error: 'محاولات كثيرة، انتظر قليلاً' });
  readJson(req, (body) => {
    const pw = body && body.password ? String(body.password) : '';
    if (verifyPassword(pw, cfg)) {
      clearAttempts(ip);
      json(res, 200, { token: makeToken(cfg.secret) });
    } else {
      json(res, 401, { error: 'كلمة المرور غير صحيحة' });
    }
  });
}

function handleChangePassword(req, res, cfg) {
  readJson(req, (body) => {
    const cur = body && body.current ? String(body.current) : '';
    const next = body && body.next ? String(body.next) : '';
    if (!verifyPassword(cur, cfg)) return json(res, 401, { error: 'كلمة المرور الحالية غير صحيحة' });
    if (next.length < 3) return json(res, 400, { error: 'كلمة المرور الجديدة قصيرة جداً (3 أحرف على الأقل)' });
    cfg.passwordHash = hashPassword(next, cfg.salt);
    cfg.secret = crypto.randomBytes(32).toString('hex'); // يبطل كل الجلسات السابقة
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    json(res, 200, { ok: true });
  });
}

function handleList(res) {
  const items = loadItems();
  items.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  json(res, 200, items);
}

function createFileItem(filename, contentType, data, items) {
  const id = crypto.randomUUID();
  const mime = sniffMime(contentType, data, filename);
  filename = String(filename || 'file').split(/[\\/]/).pop().slice(0, 200);
  let ext = '';
  const em = /\.([A-Za-z0-9]{1,10})$/.exec(filename);
  if (em) ext = '.' + em[1].toLowerCase();
  if (!ext) ext = extFromMime(mime);
  const storedName = id + ext;
  fs.writeFileSync(path.join(UPLOADS_DIR, storedName), data);
  const type = mime.startsWith('image/') ? 'image' :
               mime.startsWith('video/') ? 'video' :
               mime.startsWith('audio/') ? 'audio' : 'file';
  const item = { id, type, filename, storedName, mime, size: data.length, createdAt: Date.now() };
  items.push(item);
  return item;
}

function handleUpload(req, res) {
  const ct = req.headers['content-type'] || '';
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!m) return json(res, 400, { error: 'bad request' });
  const boundary = (m[1] || m[2]).trim();
  readBody(req, MAX_BODY, (err, buf) => {
    if (err || !buf) return json(res, 413, { error: 'الملف كبير جداً' });
    const parts = parseMultipart(buf, boundary);
    const items = loadItems();
    const created = [];
    let text = '';
    for (const p of parts) {
      if (!p.name) continue;
      if (p.name === 'text') {
        text += (p.data ? p.data.toString('utf8') : '');
        continue;
      }
      if (p.data && p.data.length > 0) {
        created.push(createFileItem(p.filename || 'file', p.contentType, p.data, items));
      }
    }
    text = text.trim();
    if (text) {
      const item = { id: crypto.randomUUID(), type: 'text', text, createdAt: Date.now() };
      items.push(item);
      created.push(item);
    }
    saveItems(items);
    json(res, 200, { created });
  });
}

function handleFile(req, res, url, id) {
  const items = loadItems();
  const item = items.find((i) => i.id === id);
  if (!item || item.type === 'text') return json(res, 404, { error: 'not found' });
  const filePath = path.join(UPLOADS_DIR, item.storedName);
  if (!fs.existsSync(filePath)) return json(res, 404, { error: 'file missing' });
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const download = url.searchParams.get('download') === '1';
  const headers = withCors({
    'Content-Type': item.mime || 'application/octet-stream',
    'Content-Disposition': contentDisposition(item.filename, download),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=31536000',
  });
  const range = req.headers.range;
  if (range) {
    const rm = /bytes=(\d*)-(\d*)/.exec(range);
    if (rm) {
      let start = rm[1] ? parseInt(rm[1], 10) : 0;
      let end = rm[2] ? parseInt(rm[2], 10) : size - 1;
      if (isNaN(start)) { start = Math.max(0, size - end); end = size - 1; }
      if (isNaN(end)) end = size - 1;
      if (start < 0) start = 0;
      if (end >= size) end = size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, withCors({ 'Content-Range': 'bytes */' + size }));
        return res.end();
      }
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
  }
  headers['Content-Length'] = size;
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

function handleDelete(res, id) {
  const items = loadItems();
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return json(res, 404, { error: 'not found' });
  const [item] = items.splice(idx, 1);
  if (item.type !== 'text') {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, item.storedName)); } catch (e) {}
  }
  saveItems(items);
  json(res, 200, { ok: true });
}

function handleClear(res) {
  const items = loadItems();
  for (const it of items) {
    if (it.type !== 'text') {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, it.storedName)); } catch (e) {}
    }
  }
  saveItems([]);
  json(res, 200, { ok: true });
}

/* ---------------- router ---------------- */

function route(req, res, url, pathname) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, withCors({ 'Access-Control-Max-Age': '86400' }));
    return res.end();
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) return sendIndex(res);
  if (req.method === 'GET' && pathname === '/favicon.ico') { res.writeHead(204, withCors()); return res.end(); }
  if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true });

  const cfg = loadConfig();

  if (req.method === 'POST' && pathname === '/api/login') return handleLogin(req, res, cfg);

  const token = getAuth(req, url);
  if (!checkToken(token, cfg.secret)) return json(res, 401, { error: 'unauthorized' });

  if (req.method === 'GET' && pathname === '/api/me') return json(res, 200, { authed: true });
  if (req.method === 'GET' && pathname === '/api/items') return handleList(res);
  if (req.method === 'POST' && pathname === '/api/upload') return handleUpload(req, res);
  if (req.method === 'POST' && pathname === '/api/change-password') return handleChangePassword(req, res, cfg);
  if (req.method === 'DELETE' && pathname === '/api/items') return handleClear(res);

  const fm = pathname.match(/^\/api\/file\/([^/]+)$/);
  if (fm && req.method === 'GET') return handleFile(req, res, url, fm[1]);

  const dm = pathname.match(/^\/api\/items\/([^/]+)$/);
  if (dm && req.method === 'DELETE') return handleDelete(res, dm[1]);

  json(res, 404, { error: 'not found' });
}

/* ---------------- start ---------------- */

ensureData();

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (e) { return json(res, 400, { error: 'bad request' }); }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch (e) { return json(res, 400, { error: 'bad request' }); }
  try {
    route(req, res, url, pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log('Send-to-Self running on http://localhost:' + PORT);
  console.log('Data directory: ' + DATA_DIR);
});
