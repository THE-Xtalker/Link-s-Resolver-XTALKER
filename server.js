const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const { StalkerClient } = require('./stalker');
const { renderConfigPage } = require('./config-page');

// ---------- Manifest ----------
const manifest = {
  id: 'org.stalker.resolver',
  version: '1.0.0',
  name: 'Stalker Resolver',
  description: 'Resolvedor de links para portais Stalker/Ministra',
  resources: ['catalog', 'stream'],
  types: ['tv', 'movie'],
  catalogs: [
    { type: 'tv',    id: 'stalker_tv',     name: 'Stalker — Canais TV' },
    { type: 'movie', id: 'stalker_movies', name: 'Stalker — Filmes' }
  ],
  behaviorHints: { configurable: true, configurationRequired: true }
};

const builder = new addonBuilder(manifest);

// ---------- Helpers ----------
function decodeConfig(b64) {
  if (!b64) return null;
  try {
    const decodedB64 = decodeURIComponent(b64);
    const standardB64 = decodedB64.replace(/-/g, '+').replace(/_/g, '/');
    const s = Buffer.from(standardB64, 'base64').toString('utf8');
    return JSON.parse(s);
  } catch { return null; }
}

function encItem(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function decItem(id) {
  return JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
}

// ---------- Catalog handler ----------
builder.defineCatalogHandler(async ({ type, config }) => {
  const cfg = decodeConfig(config);
  if (!cfg) throw new Error('Configuração em falta');

  const client = new StalkerClient(cfg);
  await client.handshake();
  await client.getProfile();

  const metas = [];

  if (type === 'tv') {
    const all = await client.getChannels();
    const allowed = new Set(cfg.tvGenres || []);
    for (const ch of all) {
      if (allowed.size && !allowed.has(String(ch.tv_genre_id))) continue;
      metas.push({
        id: encItem({ kind: 'tv', cmd: ch.cmd, name: ch.name }),
        type: 'tv',
        name: ch.name || 'Canal',
        poster: ch.logo || undefined,
        posterShape: 'square',
        description: ch.tv_genre_id ? `Género #${ch.tv_genre_id}` : ''
      });
    }
  } else if (type === 'movie') {
    const cats = (cfg.vodGenres || []).slice(0, 8);
    for (const cat of cats) {
      const items = await client.getVodList(cat);
      for (const it of items) {
        if (String(it.is_series) === '1') continue;
        metas.push({
          id: encItem({ kind: 'vod', cmd: it.cmd, name: it.name }),
          type: 'movie',
          name: it.name,
          poster: it.screenshot_uri || undefined,
          description: it.description || ''
        });
      }
    }
  }

  return { metas };
});

// ---------- Stream handler ----------
builder.defineStreamHandler(async ({ id, config }) => {
  const cfg = decodeConfig(config);
  if (!cfg) throw new Error('Configuração em falta');

  const data = decItem(id);
  const client = new StalkerClient(cfg);
  await client.handshake();
  await client.getProfile();

  let url;
  if (data.kind === 'tv') url = await client.createTvLink(data.cmd);
  else                    url = await client.createVodLink(data.cmd);

  return {
    streams: [{
      title: data.name || 'Stream',
      url,
      behaviorHints: { notWebReady: false }
    }]
  };
});

// ---------- Express app ----------
const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/health', (_req, res) => res.send('ok'));
app.get('/configure', (_req, res) => res.type('html').send(renderConfigPage()));
app.get('/', (_req, res) => res.redirect('/configure'));

// Validação inicial (handshake + categorias)
app.post('/api/validate', async (req, res) => {
  try {
    const client = new StalkerClient(req.body);
    await client.handshake();
    await client.getProfile();

    let tvGenres = [], vodGenres = [];
    try { tvGenres  = await client.getGenres('itv'); } catch (_) {}
    try { vodGenres = await client.getVodCategories(); } catch (_) {}

    res.json({ ok: true, tvGenres, vodGenres });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Rota explícita para o manifesto para evitar erros 404
app.get('/:config/manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(manifest));
});

// Addon router (serve /{config}/manifest.json, etc.)
app.use(getRouter(builder.getInterface()));

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log('Addon a correr na porta ' + PORT));
