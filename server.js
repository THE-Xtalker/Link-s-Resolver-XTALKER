const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const { StalkerClient } = require('./stalker');
const { renderConfigPage } = require('./config-page');

// ---------- Manifest ----------
const manifest = {
  id: 'org.stalker.resolver',
  version: '1.0.3',
  name: 'Stalker Resolver',
  description: 'Resolvedor de links para portais Stalker/Ministra',
  resources: ['catalog', 'stream'],
  types: ['tv', 'movie'],
  catalogs: [
    { type: 'tv',    id: 'stalker_tv',     name: 'Stalker — Canais TV' },
    { type: 'movie', id: 'stalker_movies', name: 'Stalker — Filmes' }
  ],
  config: [
    { key: 'portalUrl', type: 'text', title: 'URL do Servidor' },
    { key: 'mac',       type: 'text', title: 'MAC Address' },
    { key: 'sn',        type: 'text', title: 'SN' },
    { key: 'deviceId',  type: 'text', title: 'Device ID 1' },
    { key: 'deviceId2', type: 'text', title: 'Device ID 2' },
    { key: 'signature', type: 'text', title: 'Signature' },
    { key: 'proxyUrl',  type: 'text', title: 'Proxy / VPN' },
    { key: 'tvGenres',  type: 'text', title: 'Categorias TV' },
    { key: 'vodGenres', type: 'text', title: 'Categorias VOD' }
  ],
  behaviorHints: { 
    configurable: true, 
    configurationRequired: true 
  }
};

const builder = new addonBuilder(manifest);

// ---------- Helpers ----------
function decodeConfig(b64) {
  if (!b64) return null;
  try {
    const s = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
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

  console.log(`[CATALOG] A pedir catálogo tipo: ${type}`);
  
  const client = new StalkerClient(cfg);
  await client.handshake();
  await client.getProfile();

  const metas = [];

  if (type === 'tv') {
    const genres = (cfg.tvGenres && cfg.tvGenres.length > 0) ? cfg.tvGenres : ['*'];
    let allChannels = [];

    for (const genre of genres) {
      console.log(`[CATALOG] A buscar canais da categoria: ${genre}`);
      const channels = await client.getChannels(genre);
      console.log(`[CATALOG] Encontrados ${channels.length} canais.`);
      allChannels = allChannels.concat(channels);
    }

    const seen = new Set();
    for (const ch of allChannels) {
      if (!seen.has(ch.id)) {
        seen.add(ch.id);
        metas.push({
          id: encItem({ kind: 'tv', cmd: ch.cmd, name: ch.name }),
          type: 'tv',
          name: ch.name || 'Canal',
          poster: ch.logo || undefined,
          posterShape: 'square',
          description: 'Canal de TV em Direto'
        });
      }
    }
  } else if (type === 'movie') {
    const cats = (cfg.vodGenres && cfg.vodGenres.length > 0) ? cfg.vodGenres : ['*'];
    
    for (const cat of cats) {
      console.log(`[CATALOG] A buscar filmes da categoria: ${cat}`);
      const items = await client.getVodList(cat);
      console.log(`[CATALOG] Encontrados ${items.length} itens.`);
      
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

  console.log(`[CATALOG] A devolver ${metas.length} itens para o Stremio.`);
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

// 1. Rotas básicas
app.get('/health', (_req, res) => res.send('ok'));
app.get('/configure', (_req, res) => res.type('html').send(renderConfigPage()));
app.get('/', (_req, res) => res.redirect('/configure'));

// 2. Rota de validação (TEM DE ESTAR ANTES DO ADDON ROUTER)
app.post('/api/validate', async (req, res) => {
  console.log('[API] Pedido de validação recebido:', req.body.portalUrl);
  try {
    const client = new StalkerClient(req.body);
    await client.handshake();
    await client.getProfile();

    let tvGenres = [], vodGenres = [];
    try { tvGenres  = await client.getGenres('itv'); } catch (e) { console.log('Erro tvGenres:', e.message); }
    try { vodGenres = await client.getVodCategories(); } catch (e) { console.log('Erro vodGenres:', e.message); }

    res.json({ ok: true, tvGenres, vodGenres });
  } catch (err) {
    console.error('[API] Erro na validação:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// 3. Addon router (por último, apanha tudo o resto)
const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log('Addon a correr na porta ' + PORT));
