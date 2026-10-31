// Sakhi server: sends SOS SMS automatically and serves a live tracking page.
// No npm packages needed. Requires Node 18 or newer.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_FROM: FROM } = process.env;
const DRY_RUN = !(SID && TOKEN && FROM); // no keys: SMS is only printed in the console
const PUBLIC = path.join(__dirname, 'public');

const sessions = new Map(); // id -> { token, name, note, pos, at, active, created }
const hits = new Map();     // ip -> [timestamps] (rate limit)
const MAX_PER_HOUR = 5;
const SESSION_TTL = 12 * 3600 * 1000;

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 20000) { reject(new Error('Too large')); req.destroy() } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch (e) { reject(new Error('Bad JSON')) } });
  });
}
function clientIp(req) {
  if (process.env.TRUST_PROXY) return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  return req.socket.remoteAddress;
}
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 3600 * 1000);
  if (list.length >= MAX_PER_HOUR) { hits.set(ip, list); return true }
  list.push(now); hits.set(ip, list); return false;
}
function e164(n) {
  const raw = String(n).trim();
  const d = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return d.length >= 8 && d.length <= 15 ? '+' + d : null;
  if (d.length === 10) return '+91' + d;                     // India default
  if (d.length === 12 && d.startsWith('91')) return '+' + d;
  return d.length >= 11 && d.length <= 15 ? '+' + d : null;
}
function validPos(p) {
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

async function sendSms(to, body) {
  if (DRY_RUN) { console.log(`[DRY RUN] SMS to ${to}: ${body}`); return { ok: true, dry: true } }
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ To: to, From: FROM, Body: body })
    });
    if (!r.ok) { const t = await r.text(); console.error('SMS failed', to, r.status, t.slice(0, 200)); return { ok: false } }
    return { ok: true };
  } catch (e) { console.error('SMS error', e.message); return { ok: false } }
}

const routes = {
  // Start an SOS: create a tracking session and text every contact
  async '/api/sos'(req, res) {
    const ip = clientIp(req);
    if (limited(ip)) return send(res, 429, { error: 'Too many alerts from this device. Try again later.' });
    const b = await readJson(req);
    const list = (Array.isArray(b.contacts) ? b.contacts : []).slice(0, 5)
      .map(c => ({ name: String(c.name || '').slice(0, 40), num: e164(c.num) })).filter(c => c.num);
    if (!list.length) return send(res, 400, { error: 'No valid contacts' });
    const id = crypto.randomBytes(9).toString('base64url');
    const token = crypto.randomBytes(16).toString('hex');
    const note = String(b.note || '').slice(0, 120);
    const pos = validPos(b.pos) ? { lat: b.pos.lat, lng: b.pos.lng, acc: Math.round(b.pos.acc) || 0 } : null;
    sessions.set(id, { token, note, pos, at: Date.now(), active: true, created: Date.now() });
    const link = `${BASE_URL}/t/${id}`;
    const text = `SOS from Sakhi: I need help. ${note ? note + ' ' : ''}Track my live location: ${link}` +
      (pos ? ` (last: https://maps.google.com/?q=${pos.lat.toFixed(5)},${pos.lng.toFixed(5)})` : '') +
      ' Please call me or the police (112).';
    const results = await Promise.all(list.map(async c => ({ name: c.name, ...(await sendSms(c.num, text)) })));
    send(res, 200, { id, token, link, results });
  },
  // Update the position while the SOS is active
  async '/api/loc'(req, res) {
    const b = await readJson(req);
    const s = sessions.get(b.id);
    if (!s || s.token !== b.token || !s.active) return send(res, 404, { error: 'No active session' });
    if (!validPos(b.pos)) return send(res, 400, { error: 'Bad position' });
    s.pos = { lat: b.pos.lat, lng: b.pos.lng, acc: Math.round(b.pos.acc) || 0 };
    s.at = Date.now();
    send(res, 200, { ok: true });
  },
  // Person is safe: stop sharing
  async '/api/stop'(req, res) {
    const b = await readJson(req);
    const s = sessions.get(b.id);
    if (!s || s.token !== b.token) return send(res, 404, { error: 'No session' });
    s.active = false; s.at = Date.now();
    send(res, 200, { ok: true });
  }
};

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found') }
    res.writeHead(200, { 'Content-Type': (MIME[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && routes[url.pathname]) return await routes[url.pathname](req, res);
    if (req.method === 'GET' && url.pathname.startsWith('/api/loc/')) {
      const s = sessions.get(url.pathname.slice(9));
      if (!s) return send(res, 404, { error: 'Not found' });
      return send(res, 200, { active: s.active, note: s.note, pos: s.pos, at: s.at });
    }
    if (req.method === 'GET' && /^\/t\/[\w-]+$/.test(url.pathname)) return serveFile(res, path.join(PUBLIC, 'track.html'));
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.normalize(path.join(PUBLIC, rel));
      if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end() }
      return serveFile(res, file);
    }
    res.writeHead(405); res.end();
  } catch (e) { send(res, 400, { error: e.message }) }
}).listen(PORT, () => {
  console.log(`Sakhi running at ${BASE_URL}`);
  console.log(DRY_RUN ? 'SMS mode: DRY RUN (no Twilio keys set, messages are only printed here)' : 'SMS mode: Twilio');
});

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.created > SESSION_TTL) sessions.delete(id);
}, 600000).unref();
