const express = require('express');
const { StalkerClient } = require('./stalker');
const { renderConfigPage } = require('./config-page');

const manifest = {
  id: 'org.stalker.resolver',
  version: '1.1.0',
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

// Limpa e corrige URLs (igual ao teu stalkerengine)
function extractUrlFix(jsData) {
    if (!jsData) return null;
    let url = jsData?.cmd || jsData?.url || (typeof jsData === 'string' ? jsData : null);
    if (!url && typeof jsData === 'object') {
        url = Object.values(jsData).find(v => typeof v === 'string' && (v.startsWith('http') || v.includes('://')));
    }
    if (!url) return null;
    url = url.trim().replace(/^['"`]?(ffrt|ffmpeg|ffrt2|rtmp)['"`]?\s+/i, "").trim();
    url = url.replace(/[\s\t\r\n]+/g, "");
    return url;
}

// ---------- lógica do Catálogo ----------
async function runCatalog(type, config) {
  if (!config || !config.portalUrl) throw new Error('Configuração em falta (portalUrl)');
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

// ---------- lógica do Meta (Obrigatório para o botão Play aparecer) ----------
async function runMeta(type, id) {
  const data = decItem(id);
  return {
    meta: {
      id: id,
      type: type,
      name: data.name || 'Canal',
      description: 'Canal em Direto',
      videos: [{
        id: id,
        title: data.name || 'Tocar Canal',
        released: new Date().toISOString()
      }]
    }
  };
}

// ---------- lógica do Stream (Redirecionamento para 0 Banda) ----------
async function runStream(id, config, host, protocol) {
  if (!config || !config.portalUrl) throw new Error('Configuração em falta');
  const data = decItem(id);
  
  // O URL que o Stremio vai ler. Em vez do link final, aponta para a nossa rota /meta
  // A TV vai pedir a rota /meta, e nós fazemos o Redirect 302 para o portal.
  const shieldUrl = `${protocol}://${host}/meta/${encodeURIComponent(JSON.stringify(config) ? Buffer.from(JSON.stringify(config)).toString('base64url') : '')}/${encodeURIComponent(id)}?type=${data.kind}`;

  // Nota: Em produção, deves usar a string Base64 original da configuração.
  // Para simplificar, se ela não estiver acessível aqui, enviamos o link final direto para VOD.
  // Mas para TV, usamos o shield para enganar o player da TV.

  return { 
    streams: [{ 
      title: `▶️ ${data.name || 'Tocar Canal'}`,
      url: shieldUrl,
      behaviorHints: { 
        notWebReady: true,
        proxyHeaders: { request: {} }
      } 
    }] 
  };
}

// ---------- express ----------
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

// Manifest
app.get('/manifest.json', (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.json(manifest); });
app.get('/:config/manifest.json', (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.json(manifest); });

// Catálogo
app.get('/:config/catalog/:type/:id.json', async (req, res) => {
  try {
    const config = decodeConfig(req.params.config);
    res.json(await runCatalog(req.params.type, config));
  } catch (e) { res.status(500).json({ metas: [] }); }
});

// Meta (Ecrã de detalhes)
app.get('/:config/meta/:type/:id.json', async (req, res) => {
  try {
    res.json(await runMeta(req.params.type, req.params.id));
  } catch (e) { res.status(500).json({ err: e.message }); }
});

// Stream (Devolve o link do nosso /meta)
app.get('/:config/stream/:type/:id.json', async (req, res) => {
  try {
    const config = decodeConfig(req.params.config);
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    
    // Constrói o URL do nosso "escudo" /meta
    // Usamos a config original que veio no URL
    const shieldUrl = `${protocol}://${host}/meta/${req.params.config}/${encodeURIComponent(req.params.id)}?type=${req.params.type}`;

    const data = decItem(req.params.id);
    
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
// 👇 O META-SHIELD: Zero Banda e Reset de Player da TV 👇
// ============================================================
app.get("/meta/:config/:id", async (req, res) => {
    try {
        const config = decodeConfig(req.params.config);
        const data = decItem(req.params.id);
        
        const client = new StalkerClient(config);
        await client.handshake();
        
        // Obtém o link final do portal
        let streamUrl = data.kind === 'tv' 
            ? await client.createTvLink(data.cmd)
            : await client.createVodLink(data.cmd);
            
        streamUrl = extractUrlFix(streamUrl);
        
        if (!streamUrl) return res.status(404).send("Stream não encontrado");

        console.log(`[META-SHIELD] 302 Redirect para: ${streamUrl.substring(0, 60)}...`);

        // O Redirect 302 diz à TV para ir buscar o vídeo diretamente ao portal
        res.redirect(302, streamUrl);
        
    } catch (e) {
        console.error('[META-SHIELD ERROR]', e.message);
        res.status(500).end();
    }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log('Addon a correr na porta ' + PORT));
