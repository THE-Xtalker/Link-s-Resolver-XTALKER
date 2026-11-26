const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const crypto = require('crypto');

class StalkerClient {
  constructor(cfg) {
    this.portal = (cfg.portalUrl || '').replace(/\/+$/, '');
    this.mac = cfg.mac || '';
    this.sn = cfg.sn || '';
    this.deviceId = cfg.deviceId || '';
    this.deviceId2 = cfg.deviceId2 || '';
    this.signature = cfg.signature || '88e76854';
    this.proxyUrl = cfg.proxyUrl || '';
    this.token = null;
    this.apiBase = null;
    this.http = null;
    this._buildHttp();
  }

  _buildHttp() {
    const opts = {
      timeout: 15000,
      validateStatus: () => true
    };
    if (this.proxyUrl) {
      const agent = this.proxyUrl.startsWith('socks')
        ? new SocksProxyAgent(this.proxyUrl)
        : new HttpsProxyAgent(this.proxyUrl);
      opts.httpAgent = agent;
      opts.httpsAgent = agent;
    }
    this.http = axios.create(opts);
  }

  _headers() {
    const deviceId = this.deviceId || crypto.createHash('md5').update(this.mac).digest('hex').toUpperCase();
    const shortHash = crypto.createHash('md5').update(this.mac).digest('hex').substring(0, 13).toUpperCase();
    const serialNumber = this.sn || `8CA3${shortHash.substring(4)}`;
    const fakeResidencialIP = '188.81.121.45'; // TRUQUE DO STALKERENGINE

    const h = {
      'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
      'X-User-Agent': `Model: MAG250; SW: 2.18-r14-pub-250; STB_active: true; Device ID: ${deviceId}; Device ID 2: ${this.deviceId2 || deviceId}; Signature: ${this.signature}; SN: ${serialNumber}`,
      'Referer': `${this.portal}/c/`,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Forwarded-For': fakeResidencialIP,
      'X-Real-IP': fakeResidencialIP,
      'Client-IP': fakeResidencialIP,
      'Cookie': `mac=${encodeURIComponent(this.mac)}; stb_lang=en; timezone=Europe/Lisbon;`
    };
    if (this.token) {
      h.Authorization = `Bearer ${this.token}`;
      h.Cookie += ` token=${this.token}; access_token=${this.token};`;
    }
    return h;
  }

  async handshake() {
    const baseUrl = this.portal.replace(/\/c$/, '');
    // Caminhos modernos e clássicos juntos para máxima compatibilidade
    const paths = [
        '/c/portal.php', '/portal.php', '/server/load.php', '/stalker_portal/server/load.php',
        '/stalker_portal/c/portal.php'
    ];
    
    for (const path of paths) {
      try {
        const fullUrl = `${baseUrl}${path}?type=stb&action=handshake&mac=${encodeURIComponent(this.mac)}&JsHttpRequest=1-0`;
        const r = await this.http.get(fullUrl, { headers: this._headers() });
        
        let data = r.data;
        if (typeof data === 'string') data = JSON.parse(data.replace(/\/\*[\s\S]*?\*\//g, "").trim()); // Limpa JSONP
        
        if (data && data.js && data.js.token) {
          this.token = data.js.token;
          this.apiBase = `${baseUrl}${path}?`;
          console.log(`[AUTH] Sucesso em: ${path}`);
          
          // Obter perfil (obrigatório)
          await this.http.get(`${this.apiBase}type=stb&action=get_profile&token=${this.token}&JsHttpRequest=1-0`, { headers: this._headers() });
          return this.token;
        }
      } catch (e) {
        // Continua para o próximo caminho
      }
    }
    throw new Error('Handshake falhou. O MAC está correto ou o portal bloqueou o IP?');
  }

  async getGenres(type) {
    const url = `${this.apiBase}type=${type}&action=get_genres&JsHttpRequest=1-0`;
    const r = await this.http.get(url, { headers: this._headers() });
    const data = r.data?.js?.data || r.data?.js || [];
    return (Array.isArray(data) ? data : Object.values(data)).map(g => ({ id: g.id, title: g.title || g.name }));
  }

  async getVodCategories() {
    const url = `${this.apiBase}type=vod&action=get_categories&JsHttpRequest=1-0`;
    const r = await this.http.get(url, { headers: this._headers() });
    const data = r.data?.js?.data || r.data?.js || [];
    return (Array.isArray(data) ? data : Object.values(data)).map(g => ({ id: g.id, title: g.title || g.name }));
  }

  async getChannelsPage(genreId, page = 1) {
    const g = (!genreId || genreId === '*') ? '*' : genreId;
    const url = `${this.apiBase}type=itv&action=get_ordered_list&genre=${g}&p=${page}&force_ch_link_check=0&JsHttpRequest=1-0`;
    try {
      const r = await this.http.get(url, { headers: this._headers() });
      const data = r.data?.js?.data || r.data?.js || [];
      return Array.isArray(data) ? data : Object.values(data);
    } catch (e) { return []; }
  }

  async getVodPage(categoryId, page = 1) {
    let url = `${this.apiBase}type=vod&action=get_ordered_list&p=${page}&JsHttpRequest=1-0`;
    if (categoryId && categoryId !== '*') url += `&category=${categoryId}`;
    try {
      const r = await this.http.get(url, { headers: this._headers() });
      const data = r.data?.js?.data || r.data?.js || [];
      return Array.isArray(data) ? data : Object.values(data);
    } catch (e) { return []; }
  }

  async createTvLink(cmd) {
    const url = `${this.apiBase}type=itv&action=create_link&cmd=${encodeURIComponent(cmd)}&series=&forced_storage=0&disable_ad=0&download=0&force_ch_link_check=0&JsHttpRequest=1-0`;
    const r = await this.http.get(url, { headers: this._headers() });
    const js = r.data && r.data.js;
    if (!js || !js.cmd) throw new Error('create_link falhou');
    return this._cleanUrl(js.cmd.split(' ').pop());
  }

  async createVodLink(cmd) {
    const url = `${this.apiBase}type=vod&action=create_link&cmd=${encodeURIComponent(cmd)}&series=&forced_storage=0&disable_ad=0&download=0&JsHttpRequest=1-0`;
    const r = await this.http.get(url, { headers: this._headers() });
    const js = r.data && r.data.js;
    if (!js || !js.cmd) throw new Error('create_link VOD falhou');
    return this._cleanUrl(js.cmd.split(' ').pop());
  }

  _cleanUrl(url) {
    if (!url) return url;
    // Remove prefixos estranhos como "ffmpeg " que alguns portais enviam
    return url.trim().replace(/^['"`]?(ffrt|ffmpeg|ffrt2|rtmp)['"`]?\s+/i, "").trim();
  }
}

module.exports = { StalkerClient };
