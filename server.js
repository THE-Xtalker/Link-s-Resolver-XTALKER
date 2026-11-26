const express = require('express');
const { StalkerClient } = require('./stalker');
const { renderConfigPage } = require('./config-page');

const manifest = {
  id: 'org.stalker.resolver',
  version: '1.1.2',
  name: 'Stalker Resolver',
  description: 'Resolvedor de links para portais Stalker',
  resources: ['catalog', 'stream', 'meta'],
  types: ['tv', 'movie'],
  catalogs: [
    { type: 'tv',    id: 'stalker_tv',     name: 'Stalker — Canais TV' },
    { type: 'movie', id: 'stalker_movies', name: 'Stalker — Filmes' }
  ],
  behaviorHints: { configurable: true }
};

function decodeConfig(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (e) { return null; }
}

function encItem(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function decItem(id) { return JSON.parse(Buffer.from(decodeURIComponent(id).replace(/\.json$/, ''), 'base64url').toString('utf8')); }

async function runCatalog(type, config) {
  if (!config || !config.portalUrl) throw new Error('Configuração em falta');
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
  return { metas };
}

async function runMeta(type, id) {
  const data = decItem(id);
  return {
    meta: {
      id: id, type: type, name: data.name || 'Canal', description: 'Canal em Direto',
      videos: [{ id: id, title: data.name || 'Tocar Canal', released: new Date().toISOString() }]
    }
  };
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/health', (_req, res) => res.send('ok'));
app.get('/configure', (_req, res) => res.type('html').send(renderConfigPage()));
app.get('/', (_req, res) => res.redirect('/configure'));

// ============================================================
// 👇 A ROTA QUE FALTAVA (RESOLVE O ERRO 404 DA PÁGINA) 👇
// ============================================================
app.post('/api/validate', async (req, res) => {
  try {
    const client = new StalkerClient(req.body);
    await client.handshake();
    const tvGenres = await client.getGenres('itv').catch(() => []);
    const vodGenres = await client.getVodCategories().catch(() => []);
    res.json({ ok: true, tvGenres, vodGenres });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/manifest.json', (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.json(manifest); });
app.get('/:config/manifest.json', (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.json(manifest); });

app.get('/:config/catalog/:type/:id.json', async (req, res) => {
  try {
    const config = decodeConfig(req.params.config);
    res.json(await runCatalog(req.params.type, config));
  } catch (e) { res.status(500).json({ metas: [] }); }
});

app.get('/:config/meta/:type/:id.json', async (req, res) => {
  try {
    res.json(await runMeta(req.params.type, req.params.id));
  } catch (e) { res.status(500).json({ err: e.message }); }
});

app.get('/:config/stream/:type/:id.json', async (req, res) => {
  try {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    const data = decItem(req.params.id);
    
    // Aponta o Stremio para o nosso META-SHIELD
    const shieldUrl = `${protocol}://${host}/meta/${req.params.config}/${encodeURIComponent(req.params.id)}?type=${req.params.type}`;

    res.json({ 
      streams: [{ 
        title: `▶️ ${data.name || 'Tocar Canal'}`,
        url: shieldUrl,
        behaviorHints: { notWebReady: true } 
      }] 
    });
  } catch (e) { res.status(500).json({ streams: [] }); }
});

// ============================================================
// 👇 META-SHIELD: Zero Banda 👇
// ============================================================
app.get("/meta/:config/:id", async (req, res) => {
    try {
        const config = decodeConfig(req.params.config);
        const data = decItem(req.params.id);
        const client = new StalkerClient(config);
        await client.handshake();
        
        let streamUrl = data.kind === 'tv' 
            ? await client.createTvLink(data.cmd)
            : await client.createVodLink(data.cmd);
            
        if (!streamUrl) return res.status(404).send("Stream não encontrado");

        console.log(`[META-SHIELD] 302 Redirect (Zero Banda) para: ${streamUrl.substring(0, 60)}...`);
        res.redirect(302, streamUrl);
        
    } catch (e) {
        console.error('[META-SHIELD ERROR]', e.message);
        res.status(500).end();
    }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log('Addon a correr na porta ' + PORT));
