import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initSessionManager, getOrCreateSession, getSession } from './SessionManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);

// CORS: default to same-origin / no-origin only. A wildcard `*` default would let
// any website the user visits issue cross-origin requests to this server (reading
// chat lists, marking chats read, triggering summaries). Cross-origin access is
// only granted for explicitly listed origins via ALLOWED_ORIGINS.
const defaultAllowedOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
];
const envAllowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : [];
const allowedOrigins = [...new Set([...defaultAllowedOrigins, ...envAllowedOrigins])];
const corsOptions = {
    origin(origin, callback) {
        // No Origin header = same-origin/curl/native client → allow.
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
};

const io = new Server(httpServer, {
    cors: corsOptions,
});

app.use(cors(corsOptions));
app.use(express.json());

const DEFAULT_SESSION_ID = 'blinky-default-session';

// Serve built frontend
const frontendDistCandidates = [
    path.join(__dirname, 'frontend', 'dist'),
    path.join(__dirname, 'frontend'),
    path.join(process.cwd(), 'frontend', 'dist'),
    path.join(__dirname, '..', 'frontend', 'dist'),
];
const frontendDist = frontendDistCandidates.find((p) => existsSync(path.join(p, 'index.html'))) || frontendDistCandidates[0];
app.use(express.static(frontendDist));

// ── Session middleware ─────────────────────────────────────────────────────────
// Loopback + optional shared-token gate. The service is local-only by default
// (HOST=127.0.0.1); this middleware enforces that even if bound wider, and
// adds an optional WHATSAPP_API_TOKEN bearer check for BYOK deployments.
const WHATSAPP_API_TOKEN = (process.env.WHATSAPP_API_TOKEN || '').trim();

function isLoopbackIp(ip) {
    if (!ip) return false;
    const clean = ip.replace(/^::ffff:/, '');
    return clean === '127.0.0.1' || clean === '::1' || clean === '::ffff:127.0.0.1';
}

function requireLocalhost(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || '';
    if (!isLoopbackIp(ip)) {
        return res.status(403).json({ error: 'Forbidden: WhatsApp service is loopback-only' });
    }
    next();
}

function requireApiToken(req, res, next) {
    if (!WHATSAPP_API_TOKEN) return next();
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const provided = bearer || (req.headers['x-api-token'] || '').trim();
    if (provided !== WHATSAPP_API_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized: invalid WHATSAPP_API_TOKEN' });
    }
    next();
}

function requireSession(req, res, next) {
    const sessionId = DEFAULT_SESSION_ID;
    const session = getSession(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found. Reconnect to create one.' });
    }
    req.session = session;
    next();
}

// ── REST API ──────────────────────────────────────────────────────────────────
// All local APIs require loopback + (optional) shared token, then session.
app.use('/api/', requireLocalhost, requireApiToken);

// Register / ensure a session exists.
// Always use the default session ID to share between app and web
app.post('/api/sessions', async (req, res) => {
  try {
    const sessionId = DEFAULT_SESSION_ID;
    const { isNew } = await getOrCreateSession(sessionId);
    res.json({ sessionId, isNew });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', requireSession, (req, res) => {
  res.json(req.session.getStatus());
});

app.get('/api/chats', requireSession, async (req, res) => {
  try {
        const result = await req.session.getChatsForApi();
        if (result?.status === 'disconnected') {
            return res.status(503).json({ error: 'WhatsApp not connected yet' });
        }
        res.json(result.chats || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug-chats', requireSession, async (req, res) => {
  try {
        const results = await req.session.client.pupPage.evaluate(async () => {
            const id = '120363426466297788@g.us';
            try {
                const collections = window.require ? window.require('WAWebCollections') : null;
                const chat = collections?.Chat?.get(id) || window.Store?.Chat?.get(id);
                if (!chat) return { error: "Chat not in collections" };
                const msgs = chat.msgs?.getModelsArray() || [];
                return {
                    id: chat.id?._serialized,
                    name: chat.name,
                    msgCount: msgs.length,
                    firstMsg: msgs[0]?.body,
                    lastMsg: msgs[msgs.length - 1]?.body,
                };
            } catch (e) {
                return { error: e.stack || e.message || String(e) };
            }
        });
        res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.stack || err.message });
  }
});

app.post('/api/chats/:id/read', requireSession, async (req, res) => {
    try {
        const { status } = req.session.getStatus();
        if (status !== 'connected') return res.status(503).json({ error: 'WhatsApp not connected yet' });
        const chats = await req.session.client.getChats();
        const chat = chats.find(c => c.id._serialized === req.params.id);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });
        await chat.sendSeen();
        req.session.resetUnreadCount(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/summarise', requireSession, async (req, res) => {
    try {
        const { chatId, limit = 50 } = req.body;
        if (!chatId) return res.status(400).json({ error: 'chatId required' });
        const chat = await req.session.getChatInstance(chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });
        const summary = await req.session.summariseChat(chat, parseInt(limit));
        // Ntfy push is fire-and-forget; failures must not fail the request, and
        // it is only sent when explicitly enabled (guards against surprise spam).
        if (process.env.NTFY_ENABLED === 'true') {
            req.session.sendNtfy(summary).catch((err) => {
                console.error('[SERVER] ntfy push failed:', err?.message || err);
            });
        }
        io.to(req.session.sessionId).emit('summary_done', summary);
        res.json({ summary });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/logout', requireSession, async (req, res) => {
    try {
        await req.session.logout();
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/settings', requireSession, (req, res) => {
    res.json(req.session.getSettingsForApi());
});

app.post('/api/settings', requireSession, async (req, res) => {
    try {
        await req.session.saveSettings(req.body);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Catch-all: serve React app
app.use((req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
// Each socket joins its own session room; events are scoped per-user.
// Rejects non-loopback transports and enforces WHATSAPP_API_TOKEN when set.
io.use((socket, next) => {
    const ip = socket.handshake?.address || socket.conn?.remoteAddress || '';
    if (!isLoopbackIp(ip)) {
        return next(new Error('Forbidden: loopback-only service'));
    }
    if (WHATSAPP_API_TOKEN) {
        const auth = socket.handshake?.auth || {};
        const provided = (auth.token || auth.apiToken || '').trim();
        if (provided !== WHATSAPP_API_TOKEN) {
            return next(new Error('Unauthorized: invalid WHATSAPP_API_TOKEN'));
        }
    }
    next();
});
io.on('connection', async (socket) => {
    const sessionId = DEFAULT_SESSION_ID;

    socket.join(sessionId);
    console.log(`[WS] Socket ${socket.id} joined session ${sessionId.slice(0, 8)}...`);

    // Create session if it doesn't exist yet (first-time connection).
    const { session } = await getOrCreateSession(sessionId);
    const { status, qr } = session.getStatus();
    socket.emit('status', status);
    if (status === 'qr' && qr) socket.emit('qr', qr);
    if (status === 'connected') socket.emit('ready');
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
// Bind loopback by default: the WhatsApp backend serves the local web UI only.
// Set HOST=0.0.0.0 explicitly to expose it (e.g. behind a reverse proxy).
const HOST = process.env.HOST || '127.0.0.1';
httpServer.listen(PORT, HOST, () => {
    console.log(`[SERVER] Running at http://${HOST}:${PORT}`);
});
httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        const fallback = Number(PORT) + 1;
        console.warn(`[SERVER] Port ${PORT} in use, retrying on ${fallback}...`);
        setTimeout(() => httpServer.listen(fallback, HOST, () => {
            console.log(`[SERVER] Running at http://${HOST}:${fallback}`);
        }), 1000);
    } else {
        throw err;
    }
});

initSessionManager(io).catch(err => console.error('[SERVER] Failed to init session manager:', err));

// ── Graceful shutdown ────────────────────────────────────────────────────────
async function cleanupAndExit() {
    console.log('[SERVER] Shutting down WhatsApp backend...');
    try {
        const session = getSession(DEFAULT_SESSION_ID);
        if (session?.client) {
            try { await session.client.destroy(); } catch {}
        }
        if (session) {
            try { await session.killOrphanedBrowsers(); } catch {}
        }
    } catch {}
    process.exit(0);
}

process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);

