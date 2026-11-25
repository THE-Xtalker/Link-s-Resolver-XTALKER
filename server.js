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

  console.log(`[CATALOG] A pedir catálogo tipo: ${type}`);
  
  const client = new StalkerClient(cfg);
  await client.handshake();
  await client.getProfile();

  const metas = [];

  if (type === 'tv') {
    // Se não selecionou nenhuma, pede a categoria "All" (*)
    const genres = (cfg.tvGenres && cfg.tvGenres.length > 0) ? cfg.tvGenres : ['*'];
    let allChannels = [];

    for (const genre of genres) {
      console.log(`[CATALOG] A buscar canais da categoria: ${genre}`);
      const channels = await client.getChannels(genre);
      console.log(`[CATALOG] Encontrados ${channels.length} canais.`);
      allChannels = allChannels.concat(channels);
    }

    // Remover duplicados
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

    if (!metas.length) {
      console.error('[CATALOG] portal devolveu 0');
      return { metas: [{ id: 'err-empty', type: type || 'tv', name: 'PORTAL DEVOLVEU 0' }] };
    }
    return { metas };
  } catch (e) {
    console.error('[CATALOG] ERRO ' + (e && e.message ? e.message : e));
    return { metas: [{ id: 'err-msg', type: type || 'tv', name: String(e && e.message || e).slice(0, 80) }] };
  }
});

builder.defineStreamHandler(async ({ id, config }) => {
  const cfg = decodeConfig(config);
  if (!cfg) throw new Error('Configuração em falta');
  const data = decItem(id);
  const client = new StalkerClient(cfg);
  await client.connect();
  const url = data.kind === 'tv'
    ? await client.createTvLink(data.cmd)
    : await client.createVodLink(data.cmd);
  console.log('[STREAM] ' + url.slice(0, 120));
  return { streams: [{ title: data.name || 'Stream', url: url }] };
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
    const client = new StalkerClient(req.body || {});
    const session = await client.connect();
    const cats = await client.getCategories();
    res.json({
      ok: true,
      endpoint: session.endpoint,
      profileError: client.profileError,
      tvGenres: cats.tv,
      vodGenres: cats.movies,
      seriesGenres: cats.series
    });
  } catch (err) {
    res.json({ ok: false, error: err.message || String(err) });
  }
});

// Manifesto já configurado: sem isto o Stremio mostra Configure em vez de Install
app.get('/:config/manifest.json', (req, res) => {
  const body = JSON.parse(JSON.stringify(manifest));
  if (decodeConfig(req.params.config) && body.behaviorHints) {
    delete body.behaviorHints.configurationRequired;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
});

app.get('/:config/configure', (_req, res) => res.redirect('/configure'));

// Addon router (serve /{config}/manifest.json, etc.)
app.use(getRouter(builder.getInterface()));

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log('Addon a correr na porta ' + PORT));
