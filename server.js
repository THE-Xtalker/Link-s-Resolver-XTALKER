const express = require('express');
const { StalkerClient } = require('./stalker');
const { renderConfigPage } = require('./config-page');

const manifest = {
  id: 'org.stalker.resolver',
  version: '1.0.9',
  name: 'Stalker Resolver',
  description: 'Resolvedor de links para portais Stalker',
  resources: ['catalog', 'stream', 'meta'], // 👈 ADICIONADO 'meta' AQUI
  types: ['tv', 'movie'],
  catalogs: [
    { type: 'tv',    id: 'stalker_tv',     name: 'Stalker — Canais TV' },
    { type: 'movie', id: 'stalker_movies', name: 'Stalker — Filmes' }
  ],
  behaviorHints: { configurable: true }
};

// ---------- helpers ----------
function decodeConfig(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (e) {
    console.error('[CONFIG DECODE ERROR]', e.message);
    return null;
  }
}
function encItem(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function decItem(id) {
  const clean = decodeURIComponent(id).replace(/\.json$/, '');
  return JSON.parse(Buffer.from(clean, 'base64url').toString('utf8'));
}

// ---------- lógica ----------
async function runCatalog(type, config) {
  if (!config || !config.portalUrl) throw new Error('Configuração em falta (portalUrl)');
  console.log(`[CATALOG] type=${type} | portal=${config.portalUrl}`);
  const client = new StalkerClient(config);
  await client.handshake();

  const metas = [];
  const genres = type === 'tv' ? (config.tvGenres || ['*']) : (config.vodGenres || ['*']);

  for (const genre of genres) {
    const promises = [];
    for (let p = 1; p <= 5; p++) {
      promises.push(type === 'tv' ? client.getChannelsPage(genre, p) : client.getVodPage(genre, p));
    }
    const results = await Promise.all(promises);
    const allItems = results.flat();
    console.log(`[CATALOG]  genre=${genre}  →  ${allItems.length} itens`);

    for (const item of allItems) {
      if (type === 'movie' && String(item.is_series) === '1') continue;
      metas.push({
        id: encItem({ kind: type === 'tv' ? 'tv' : 'vod', cmd: item.cmd || item.id, name: item.name }),
        type,
        name: item.name || 'Sem nome',
        poster: item.logo || item.screenshot_uri || undefined,
        posterShape: type === 'tv' ? 'square' : 'poster',
        description: type === 'tv' ? 'Canal em Direto' : (item.description || '')
      });
    }
  }
  console.log(`[CATALOG] total = ${metas.length}`);
  return { metas };
}

// 👇 NOVA FUNÇÃO PARA RESOLVER O GATO E MOSTRAR O BOTÃO PLAY 👇
async function runMeta(type, id) {
  const data = decItem(id);
  return {
    meta: {
      id: id,
      type: type,
      name: data.name || 'Canal',
      description: 'Canal em Direto',
      videos: [
        {
          id: id,
          title: data.name || 'Tocar Canal',
          released: new Date().toISOString()
        }
      ]
    }
  };
}

async function runStream(id, config) {
  if (!config || !config.portalUrl) throw new Error('Configuração em falta (portalUrl)');
  const data = decItem(id);
  const client = new StalkerClient(config);
  await client.handshake();
  const url = data.kind === 'tv'
    ? await client.createTvLink(data.cmd)
    : await client.createVodLink(data.cmd);
    
  console.log(`[STREAM] URL obtido: ${url}`);
  return { streams: [{ title: data.name || 'Stream', url, behaviorHints: { notWebReady: true } }] };
}

// ---------- express ----------
const app = express();
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`[${req.method}] ${req.originalUrl}`);
  next();
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/health', (_req, res) => res.send('ok'));
app.get('/configure', (_req, res) => res.type('html').send(renderConfigPage()));
app.get('/:config/configure', (_req, res) => res.type('html').send(renderConfigPage()));
app.get('/', (_req, res) => res.redirect('/configure'));

app.get('/debug/:config', (req, res) => {
  res.json({ raw: req.params.config, decoded: decodeConfig(req.params.config) });
});

app.post('/api/validate', async (req, res) => {
  try {
    const client = new StalkerClient(req.body);
    await client.handshake();
    const tvGenres  = await client.getGenres('itv').catch(() => []);
    const vodGenres = await client.getVodCategories().catch(() => []);
    res.json({ ok: true, tvGenres, vodGenres });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

const sendManifest = (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json(manifest);
};
app.get('/manifest.json', sendManifest);
app.get('/:config/manifest.json', sendManifest);

const catalogRoute = (fromPath) => async (req, res) => {
  try {
    const raw = fromPath ? req.params.config : req.query.config;
    const config = decodeConfig(raw);
    const result = await runCatalog(req.params.type, config);
    res.json(result);
  } catch (e) {
    console.error('[CATALOG ERROR]', e.message);
    res.status(500).json({ err: e.message, metas: [] });
  }
};
app.get('/:config/catalog/:type/:id.json', catalogRoute(true));
app.get('/catalog/:type/:id.json',          catalogRoute(false));

// 👇 NOVA ROTA META AQUI 👇
const metaRoute = (fromPath) => async (req, res) => {
  try {
    const result = await runMeta(req.params.type, req.params.id);
    res.json(result);
  } catch (e) {
    console.error('[META ERROR]', e.message);
    res.status(500).json({ err: e.message });
  }
};
app.get('/:config/meta/:type/:id.json', metaRoute(true));
app.get('/meta/:type/:id.json',         metaRoute(false));

const streamRoute = (fromPath) => async (req, res) => {
  try {
    const raw = fromPath ? req.params.config : req.query.config;
    const config = decodeConfig(raw);
    const result = await runStream(req.params.id, config);
    res.json(result);
  } catch (e) {
    console.error('[STREAM ERROR]', e.message);
    res.status(500).json({ err: e.message, streams: [] });
  }
};
app.get('/:config/stream/:type/:id.json', streamRoute(true));
app.get('/stream/:type/:id.json',         streamRoute(false));

app.use((req, res) => {
  console.warn(`[404] ${req.method} ${req.originalUrl}`);
  res.status(404).json({ err: 'Not found', path: req.path });
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log('Addon a correr na porta ' + PORT));
