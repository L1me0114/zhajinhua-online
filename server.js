import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { GameError, GameHub } from './src/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const RUNTIME_DIR = path.join(__dirname, 'runtime');
const PUBLIC_URL_FILE = path.join(RUNTIME_DIR, 'public-url.txt');
const TUNNEL_PID_FILE = path.join(RUNTIME_DIR, 'tunnel.pid');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const STARTED_AT = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
};

const hub = new GameHub();

/* -------------------------------------------------------------------------- */
/* SSE                                                                        */
/* -------------------------------------------------------------------------- */

const sseClients = new Set(); // { res, room, player }

function rawSSE(res, event, data) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    if (event) {
      res.write(`event: ${event}\ndata: ${data}\n\n`);
    } else {
      res.write(`: ${data}\n\n`);
    }
    return true;
  } catch {
    return false;
  }
}

function dropClient(entry) {
  sseClients.delete(entry);
  entry.player.sse.delete(entry.res);
  if (entry.player.sse.size === 0) {
    entry.player.connected = false;
    entry.player.lastSeen = Date.now();
  }
}

function broadcastState(room) {
  if (!hub.rooms.has(room.code)) return;
  for (const player of room.players) {
    if (player.left || player.isBot || !player.sse.size) continue;
    let payload;
    try {
      payload = JSON.stringify(hub.stateFor(room, player));
    } catch (error) {
      console.error('state serialize error', error);
      continue;
    }
    for (const res of [...player.sse]) {
      if (!rawSSE(res, 'state', payload)) {
        const entry = [...sseClients].find((c) => c.res === res);
        if (entry) dropClient(entry);
        else player.sse.delete(res);
      }
    }
  }
}

function broadcastEvent(room, event) {
  if (!hub.rooms.has(room.code)) return;
  const payload = JSON.stringify(event);
  for (const player of room.players) {
    if (player.left || player.isBot) continue;
    for (const res of [...player.sse]) {
      if (!rawSSE(res, 'event', payload)) {
        const entry = [...sseClients].find((c) => c.res === res);
        if (entry) dropClient(entry);
        else player.sse.delete(res);
      }
    }
  }
}

hub.onState = broadcastState;
hub.onEvent = broadcastEvent;

/* -------------------------------------------------------------------------- */
/* HTTP helpers                                                               */
/* -------------------------------------------------------------------------- */

function json(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function readJson(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new GameError('请求内容过大', 'PAYLOAD_TOO_LARGE', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new GameError('请求格式不正确', 'BAD_JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

function cleanText(value, max = 160) {
  if (typeof value !== 'string') return '';
  return [...value.replace(/[\u0000-\u001f\u007f]/g, '').trim()].slice(0, max).join('').trim();
}

/* -------------------------------------------------------------------------- */
/* API                                                                        */
/* -------------------------------------------------------------------------- */

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method || 'GET';

  if (pathname === '/api/health' && method === 'GET') {
    return json(res, 200, {
      ok: true,
      rooms: hub.rooms.size,
      players: [...hub.rooms.values()].reduce((n, r) => n + r.players.filter((p) => !p.isBot).length, 0),
      uptimeMs: Date.now() - STARTED_AT,
    });
  }

  if (pathname === '/api/rooms' && method === 'GET') {
    return json(res, 200, { ok: true, rooms: hub.publicRooms() });
  }

  if (pathname === '/api/network' && method === 'GET') {
    const cloud = Boolean(
      process.env.RENDER
      || process.env.FLY_APP_NAME
      || process.env.RAILWAY_ENVIRONMENT
      || process.env.KOYEB_APP_NAME
      || process.env.PUBLIC_URL,
    );
    const lan = cloud ? [] : lanAddresses().map((ip) => `http://${ip}:${PORT}`);
    const proto = req.headers['x-forwarded-proto'] || (cloud ? 'https' : 'http');
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    return json(res, 200, {
      ok: true,
      port: PORT,
      cloud,
      local: `http://127.0.0.1:${PORT}`,
      lan,
      publicUrl: readPublicUrl(),
      origin: `${proto}://${host}`,
    });
  }

  if (pathname === '/api/state' && method === 'GET') {
    const { room, player } = hub.auth(searchParams.get('code'), searchParams.get('token'));
    // 没有 SSE 的远程兼容模式也通过轮询保持在线状态
    const wasDisconnected = !player.connected;
    player.connected = true;
    player.lastSeen = Date.now();
    if (wasDisconnected) {
      hub.onReconnect(room, player);
      hub.changed(room);
    }
    return json(res, 200, { ok: true, state: hub.stateFor(room, player) });
  }

  if (pathname === '/api/events' && method === 'GET') {
    const { room, player } = hub.auth(searchParams.get('code'), searchParams.get('token'));
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write('retry: 2500\n\n');
    const entry = { res, room, player };
    sseClients.add(entry);
    player.sse.add(res);
    const wasDisconnected = !player.connected || player.justReconnected;
    player.connected = true;
    player.lastSeen = Date.now();
    if (wasDisconnected) hub.onReconnect(room, player);

    req.on('close', () => {
      const wasLast = player.sse.size <= 1;
      dropClient(entry);
      if (wasLast && hub.rooms.has(room.code)) hub.changed(room);
    });

    hub.changed(room);
    return;
  }

  if (method !== 'POST') {
    throw new GameError('接口不存在', 'NOT_FOUND', 404);
  }

  const body = await readJson(req);

  if (pathname === '/api/create') {
    const result = hub.createRoom({
      name: body.name,
      settings: body.settings,
      listed: body.listed === true,
    });
    return json(res, 200, {
      ok: true,
      code: result.room.code,
      token: result.token,
      state: hub.stateFor(result.room, result.player),
    });
  }

  if (pathname === '/api/join') {
    const result = hub.joinRoom({
      code: cleanText(body.code, 12).toUpperCase(),
      name: body.name,
      token: typeof body.token === 'string' ? body.token : null,
    });
    return json(res, 200, {
      ok: true,
      code: result.room.code,
      token: result.token,
      reconnected: result.reconnected,
      state: hub.stateFor(result.room, result.player),
    });
  }

  if (pathname === '/api/action') {
    const { room, player } = hub.auth(body.code, body.token);
    const result = hub.applyAction(room, player.seat, body.type, {
      to: body.to,
      seat: body.seat,
    });
    return json(res, 200, { ok: true, result });
  }

  if (pathname === '/api/chat') {
    const { room, player } = hub.auth(body.code, body.token);
    hub.chat(room, player, body.text);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/start') {
    const { room, player } = hub.auth(body.code, body.token);
    try {
      hub.startGame(room, player);
    } catch (error) {
      room.nextHandAt = null;
      throw error;
    }
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/settings') {
    const { room, player } = hub.auth(body.code, body.token);
    const settings = hub.updateSettings(room, player, body.settings || {});
    return json(res, 200, { ok: true, settings });
  }

  if (pathname === '/api/autostart') {
    const { room, player } = hub.auth(body.code, body.token);
    hub.setAutoStart(room, player, Boolean(body.value));
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/addbot') {
    const { room, player } = hub.auth(body.code, body.token);
    const bot = hub.addBot(room, player, body.name);
    return json(res, 200, { ok: true, seat: bot.seat, name: bot.name });
  }

  if (pathname === '/api/removebot') {
    const { room, player } = hub.auth(body.code, body.token);
    hub.removeBot(room, player, body.seat);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/kick') {
    const { room, player } = hub.auth(body.code, body.token);
    const target = hub.kick(room, player, body.seat);
    return json(res, 200, { ok: true, target });
  }

  if (pathname === '/api/reset') {
    const { room, player } = hub.auth(body.code, body.token);
    hub.resetSession(room, player);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/leave') {
    const token = typeof body.token === 'string' ? body.token : '';
    const session = token ? hub.sessions.get(token) : null;
    let sseSet = null;
    if (session) {
      const room = hub.rooms.get(session.code);
      const player = room?.players.find((p) => p.seat === session.seat && !p.left);
      if (player) sseSet = [...player.sse];
    }
    hub.leave(token);
    if (sseSet) {
      for (const res2 of sseSet) {
        try { res2.end(); } catch { /* noop */ }
      }
    }
    return json(res, 200, { ok: true });
  }

  throw new GameError('接口不存在', 'NOT_FOUND', 404);
}

/* -------------------------------------------------------------------------- */
/* 静态文件                                                                   */
/* -------------------------------------------------------------------------- */

const gzipCache = new Map();
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml)|image\/svg)/;

async function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = url.pathname;
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  if (pathname === '/favicon.ico') {
    res.writeHead(204, SECURITY_HEADERS);
    res.end();
    return;
  }

  const resolved = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== PUBLIC_DIR) {
    res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  let stat;
  try {
    stat = await fs.promises.stat(resolved);
  } catch {
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  const ext = path.extname(resolved).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const versioned = url.searchParams.has('v');
  const cacheControl = versioned ? 'public, max-age=31536000, immutable' : 'no-cache';
  const accept = String(req.headers['accept-encoding'] || '');

  if (COMPRESSIBLE.test(type) && stat.size > 1024 && /\bgzip\b/i.test(accept)) {
    const key = `${resolved}:${stat.mtimeMs}`;
    let body = gzipCache.get(key);
    if (!body) {
      body = zlib.gzipSync(await fs.promises.readFile(resolved));
      if (gzipCache.size > 80) gzipCache.clear();
      gzipCache.set(key, body);
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': type,
      'Content-Length': body.length,
      'Content-Encoding': 'gzip',
      Vary: 'Accept-Encoding',
      'Cache-Control': cacheControl,
    });
    res.end(body);
    return;
  }

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': stat.size,
    Vary: 'Accept-Encoding',
    'Cache-Control': cacheControl,
  });
  fs.createReadStream(resolved).pipe(res);
}

/* -------------------------------------------------------------------------- */
/* 启动                                                                       */
/* -------------------------------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    if (res.headersSent) {
      try { res.end(); } catch { /* noop */ }
      return;
    }
    if (error instanceof GameError) {
      json(res, error.status || 400, { ok: false, error: error.message, code: error.code });
      return;
    }
    console.error(`[${req.method} ${url.pathname}]`, error);
    json(res, 500, { ok: false, error: '服务器开小差了，请稍后再试', code: 'INTERNAL' });
  }
});

server.timeout = 0;
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

const tickTimer = setInterval(() => hub.tick(), 250);
const heartbeatTimer = setInterval(() => {
  for (const entry of [...sseClients]) {
    if (!rawSSE(entry.res, null, 'ping')) dropClient(entry);
  }
}, 15_000);

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭…`);
  clearInterval(tickTimer);
  clearInterval(heartbeatTimer);
  for (const entry of sseClients) {
    try { entry.res.end(); } catch { /* noop */ }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function lanAddresses() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) found.push(item.address);
    }
  }
  return [...new Set(found)];
}

function readPublicUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  try {
    if (fs.existsSync(TUNNEL_PID_FILE)) {
      const pid = Number(fs.readFileSync(TUNNEL_PID_FILE, 'utf8').trim());
      if (pid) {
        try {
          process.kill(pid, 0);
        } catch {
          return null;
        }
      }
    }
    const value = fs.readFileSync(PUBLIC_URL_FILE, 'utf8').trim();
    if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, '');
  } catch { /* noop */ }
  return null;
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已经被占用了，换一个端口：$env:PORT=8788; node server.js`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ♠ ♥  炸 金 花 · 联 机 版  ♦ ♣');
  console.log('  ─────────────────────────────');
  console.log(`  本机：   http://127.0.0.1:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  局域网： http://${ip}:${PORT}`);
  }
  if (readPublicUrl()) console.log(`  公网：   ${readPublicUrl()}`);
  console.log('');
  console.log('  同一 WiFi 下的朋友打开局域网地址即可加入。');
  console.log('  远程联机请运行 start-remote.bat；按 Ctrl+C 停止服务器。');
  console.log('');
});
