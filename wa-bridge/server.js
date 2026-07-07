// ПЛЮСОН WhatsApp-мост — мультисессия через whatsapp-web.js.
//
// Одна сессия на client_id (папка session/<client_id>). Клиент привязывает
// свой WhatsApp по QR. Мост слушает ТОЛЬКО 127.0.0.1 — доступен FastAPI-бэкенду
// ПЛЮСОНа, наружу не торчит. Дополнительно защищён общим токеном (заголовок
// X-Bridge-Token), чтобы никакой другой локальный процесс не мог им пользоваться.
//
// Сессии на диске (LocalAuth) переживают рестарт сервиса.
//
// HTTP API (все, кроме /health, требуют X-Bridge-Token и ?client_id):
//   GET  /health                         -> { ok }
//   POST /sessions/:clientId/start       -> инициализировать клиента (создаёт Client, начинает логин)
//   GET  /sessions/:clientId/status      -> { state } (none|starting|qr|authenticated|ready|auth_failure|disconnected)
//   GET  /sessions/:clientId/qr          -> { qr } (data:image PNG) пока state=qr
//   GET  /sessions/:clientId/chats       -> [{ id, name, isGroup, unread }]
//   POST /sessions/:clientId/send        -> { chatId, text } -> { ok, id }
//   POST /sessions/:clientId/logout      -> разлогинить и стереть сессию
//
// Конфиг через env:
//   WA_BRIDGE_PORT   (default 8790)
//   WA_BRIDGE_TOKEN  (обязателен для всех эндпоинтов кроме /health)
//   WA_BRIDGE_DATA   (default ./data) — где лежат сессии

const express = require('express');
const qrcode = require('qrcode');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = parseInt(process.env.WA_BRIDGE_PORT || '8790', 10);
const TOKEN = process.env.WA_BRIDGE_TOKEN || '';
const DATA_DIR = process.env.WA_BRIDGE_DATA || path.join(__dirname, 'data');

// Реестр живых сессий: clientId -> { client, state, qrDataUrl }
const sessions = new Map();

function puppeteerOpts() {
  return {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
    ],
  };
}

function getOrCreateSession(clientId) {
  let s = sessions.get(clientId);
  if (s) return s;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: String(clientId), dataPath: DATA_DIR }),
    puppeteer: puppeteerOpts(),
  });

  s = { client, state: 'starting', qrDataUrl: null };
  sessions.set(clientId, s);

  client.on('qr', async (qr) => {
    s.state = 'qr';
    try {
      s.qrDataUrl = await qrcode.toDataURL(qr, { width: 500, margin: 4, errorCorrectionLevel: 'M' });
    } catch (e) { console.error('[wa] qr encode error', clientId, e); }
    console.log(`[wa] client ${clientId}: QR готов`);
  });
  client.on('authenticated', () => { s.state = 'authenticated'; console.log(`[wa] client ${clientId}: authenticated`); });
  client.on('ready', () => { s.state = 'ready'; s.qrDataUrl = null; console.log(`[wa] client ${clientId}: READY`); });
  client.on('auth_failure', (m) => { s.state = 'auth_failure'; console.log(`[wa] client ${clientId}: auth_failure ${m}`); });
  client.on('disconnected', (r) => { s.state = 'disconnected'; console.log(`[wa] client ${clientId}: disconnected ${r}`); });

  client.initialize().catch((e) => {
    s.state = 'auth_failure';
    console.error(`[wa] client ${clientId}: initialize error`, e);
  });

  return s;
}

// Клиент "готов к работе" (можно слать/читать), даже если формально ещё не ready —
// whatsapp-web.js иногда подвисает на authenticated, но getChats/sendMessage уже работают.
function isUsable(s) {
  return s && (s.state === 'ready' || s.state === 'authenticated');
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => res.json({ ok: true, sessions: sessions.size }));

// auth-гейт для всех остальных эндпоинтов
app.use((req, res, next) => {
  if (!TOKEN) return res.status(500).json({ error: 'WA_BRIDGE_TOKEN не задан на мосту' });
  if (req.get('X-Bridge-Token') !== TOKEN) return res.status(401).json({ error: 'bad token' });
  next();
});

app.post('/sessions/:clientId/start', (req, res) => {
  const s = getOrCreateSession(req.params.clientId);
  res.json({ ok: true, state: s.state });
});

app.get('/sessions/:clientId/status', (req, res) => {
  const s = sessions.get(req.params.clientId);
  res.json({ state: s ? s.state : 'none' });
});

app.get('/sessions/:clientId/qr', (req, res) => {
  const s = sessions.get(req.params.clientId);
  if (!s) return res.json({ state: 'none', qr: null });
  res.json({ state: s.state, qr: s.state === 'qr' ? s.qrDataUrl : null });
});

app.get('/sessions/:clientId/chats', async (req, res) => {
  const s = sessions.get(req.params.clientId);
  if (!isUsable(s)) return res.status(409).json({ error: 'session not ready', state: s ? s.state : 'none' });
  try {
    const chats = await s.client.getChats();
    res.json(chats.map((c) => ({
      id: c.id._serialized,
      name: c.name,
      isGroup: c.isGroup,
      unread: c.unreadCount,
    })));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/sessions/:clientId/send', async (req, res) => {
  const s = sessions.get(req.params.clientId);
  if (!isUsable(s)) return res.status(409).json({ error: 'session not ready', state: s ? s.state : 'none' });
  const { chatId, text } = req.body || {};
  if (!chatId || !text) return res.status(400).json({ error: 'chatId и text обязательны' });
  try {
    const msg = await s.client.sendMessage(chatId, text);
    res.json({ ok: true, id: msg.id._serialized });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/sessions/:clientId/logout', async (req, res) => {
  const clientId = req.params.clientId;
  const s = sessions.get(clientId);
  if (!s) return res.json({ ok: true, note: 'not running' });
  try {
    try { await s.client.logout(); } catch (_) {}
    try { await s.client.destroy(); } catch (_) {}
    sessions.delete(clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.listen(PORT, '127.0.0.1', () => console.log(`[wa] ПЛЮСОН WhatsApp-мост на http://127.0.0.1:${PORT} (data: ${DATA_DIR})`));
