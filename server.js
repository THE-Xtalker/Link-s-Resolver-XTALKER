const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const { StalkerClient } = require('./stalker');
const { renderConfigPage } = require('./config-page');

const manifest = {
  id: 'org.stalker.resolver',
  version: '1.0.6',
  name: 'Stalker Resolver',
  description: 'Resolvedor de links para portais Stalker',
  resources: ['catalog', 'stream'],
  types: ['tv', 'movie'],
  catalogs: [
    { type: 'tv',    id: 'stalker_tv',     name: 'Stalker — Canais TV' },
    { type: 'movie', id: 'stalker_movies', name: 'Stalker — Filmes' }
  ],
  behaviorHints: { configurable: true }
};

const builder = new addonBuilder(manifest);

function encItem(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function decItem(id) { return JSON.parse(Buffer.from(id, 'base64url').toString('utf8')); }

builder.defineCatalogHandler(async ({ type, config }) => {
  console.log(`\n=========================================`);
  console.log(`[CATALOG] ⚠️ O STREMIO PEDIU O CATÁLOGO: ${type}`);
  console.log(`=========================================`);
  if (!config || !config.portalUrl) throw new Error('Configuração em falta');
  console.log(`[CATALOG] A pedir: ${type}`);
  
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
        type: type,
        name: item.name || 'Sem nome',
        poster: item.logo || item.screenshot_uri || undefined,
        posterShape: type === 'tv' ? 'square' : 'poster',
        description: type === 'tv' ? 'Canal em Direto' : (item.description || '')
      });
    }
  }
  return { metas };
});

builder.defineStreamHandler(async ({ id, config }) => {
  if (!config || !config.portalUrl) throw new Error('Configuração em falta');

  const data = decItem(id);
  const client = new StalkerClient(config);
  await client.handshake();

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

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.send('ok'));
app.get('/configure', (_req, res) => res.type('html').send(renderConfigPage()));
app.get('/', (_req, res) => res.redirect('/configure'));

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

// ==========================================
// 👇 ESTA É A LINHA QUE RESOLVE O ERRO 404 👇
// Intercetamos o pedido do manifesto antes do SDK
// ==========================================
app.get('/:config/manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.json(manifest);
});

// O SDK trata do catálogo e dos streams
const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log('Addon a correr na porta ' + PORT));
