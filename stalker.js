const axios = require('axios');
const http = require('http');
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

const USER_AGENT =
  'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';

function normalizeMac(mac) {
  const hex = String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (hex.length !== 12) throw new Error('MAC inválido. Formato: 00:1A:79:XX:XX:XX');
  return hex.match(/.{2}/g).join(':');
}

function portalEndpoints(raw) {
  var input = String(raw || '').trim();
  if (!input) throw new Error('URL do servidor em falta');
  if (input.indexOf('http://') !== 0 && input.indexOf('https://') !== 0) input = 'http://' + input;

  var q = input.indexOf('?');
  var h = input.indexOf('#');
  var cut = input.length;
  if (q >= 0 && q < cut) cut = q;
  if (h >= 0 && h < cut) cut = h;
  input = input.slice(0, cut);
  while (input.charAt(input.length - 1) === '/') input = input.slice(0, -1);

  var direct = [];
  if (/\/portal\.php\( /i.test(input) || /\/server\/load\.php \)/i.test(input)) {
    direct.push(input);
    input = input.replace(/\/portal\.php\( /i, '').replace(/\/server\/load\.php \)/i, '');
    while (input.charAt(input.length - 1) === '/') input = input.slice(0, -1);
  }
  if (input.slice(-2).toLowerCase() === '/c') input = input.slice(0, -2);

  var bases = [input];
  if (input.toLowerCase().slice(-15) !== '/stalker_portal') bases.push(input + '/stalker_portal');

  var urls = direct.slice();
  bases.forEach(function (b) {
    urls.push(b + '/portal.php');
    urls.push(b + '/server/load.php');
  });
  return urls.filter(function (u, i) { return urls.indexOf(u) === i; });
}

function parseBody(data) {
  if (data == null) return null;
  if (typeof data === 'object') return data;
  const text = String(data).replace(/^\uFEFF/, '').trim();
  if (!text) return null;
  if (!text.startsWith('{') && !text.startsWith('[')) {
    if (/authorization failed|access denied|unauthorized/i.test(text)) {
      throw new Error(text.slice(0, 180));
    }
    throw new Error('Resposta inesperada: ' + text.slice(0, 140));
  }
  try { return JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('JSON inválido do portal');
  }
}

function asList(js) {
  if (!js) return [];
  if (Array.isArray(js)) return js;
  if (Array.isArray(js.data)) return js.data;
  if (typeof js === 'object') {
    const vals = Object.values(js).filter(v => v && typeof v === 'object');
    if (vals.length && vals.every(v => 'id' in v || 'title' in v || 'name' in v)) return vals;
  }
  return [];
}

function normalizeCats(js) {
  const out = [];
  const seen = new Set();
  for (const it of asList(js)) {
    if (it.id === undefined || it.id === null || it.id === '*' || it.id === '') continue;
    const id = String(it.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: it.title || it.name || it.category_name || id });
  }
  return out;
}

class StalkerClient {
  constructor(cfg) {
    this.portalInput = cfg.portalUrl || '';
    this.mac = normalizeMac(cfg.mac);
    this.sn = cfg.sn || '';
    this.deviceId = cfg.deviceId || '';
    this.deviceId2 = cfg.deviceId2 || '';
    this.signature = cfg.signature || '';
    this.proxyUrl = cfg.proxyUrl || '';
    this.endpoint = null;
    this.referer = null;
    this.token = null;
    this.cookies = {};
    this.profileError = null;
    this.http = axios.create({ timeout: 20000, validateStatus: () => true, ...this._agents() });
  }

  _agents() {
    if (this.proxyUrl) {
      const agent = this.proxyUrl.startsWith('socks')
        ? new SocksProxyAgent(this.proxyUrl)
        : new HttpsProxyAgent(this.proxyUrl, { rejectUnauthorized: false });
      return { httpAgent: agent, httpsAgent: agent };
    }
    return {
      httpAgent: new http.Agent(),
      httpsAgent: new https.Agent({ rejectUnauthorized: false })
    };
  }

  _headers() {
    const parts = [`mac=${this.mac}`, 'stb_lang=en', 'timezone=Europe/Lisbon'];
    for (const [k, v] of Object.entries(this.cookies)) {
      if (k.toLowerCase() !== 'mac') parts.push(k + '=' + v);
    }
    const h = {
      'User-Agent': USER_AGENT,
      'X-User-Agent': 'Model: MAG250; Link: Ethernet',
      Accept: '*/*',
      Cookie: parts.join('; '),
      Referer: this.referer || this.portalInput
    };
    if (this.token) h.Authorization = 'Bearer ' + this.token;
    return h;
  }

  _absorb(res) {
    const raw = res.headers && res.headers['set-cookie'];
    if (!raw) return;
    for (const c of (Array.isArray(raw) ? raw : [raw])) {
      const pair = String(c).split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) this.cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  }

  async _get(params) {
    const res = await this.http.get(this.endpoint, { params, headers: this._headers() });
    this._absorb(res);
    if (res.status >= 400) throw new Error('HTTP ' + res.status);
    return parseBody(res.data);
  }

  async connect() {
    const errors = [];
    for (const endpoint of portalEndpoints(this.portalInput)) {
      try {
        this.endpoint = endpoint;
        this.referer = endpoint.replace(/\/(portal\.php|server\/load\.php)$/i, '/c/');
        this.token = null;
        this.cookies = {};
        const data = await this._get({
          type: 'stb', action: 'handshake', token: '', prehash: 'false', JsHttpRequest: '1-xml'
        });
        const token = data && data.js && data.js.token;
        if (!token) { errors.push(endpoint + ': sem token'); continue; }
        this.token = token;
        try { await this.getProfile(); }
        catch (e) { this.profileError = e.message; }
        return { endpoint, token };
      } catch (e) {
        errors.push(endpoint + ': ' + e.message);
      }
    }
    throw new Error(errors.slice(0, 4).join(' | ') || 'Handshake falhou');
  }

  async getProfile() {
    const q = {
      type: 'stb', action: 'get_profile', hd: '1',
      num_banks: '2', stb_type: 'MAG250', client_type: 'STB',
      image_version: '218', video_out: 'hdmi', hw_version: '1.7-BD-00',
      not_valid_token: '0', auth_second_step: '1', JsHttpRequest: '1-xml'
    };
    if (this.sn) q.sn = this.sn;
    if (this.deviceId) q.device_id = this.deviceId;
    if (this.deviceId2) q.device_id2 = this.deviceId2;
    if (this.signature) q.signature = this.signature;
    const data = await this._get(q);
    return data && data.js;
  }

  async _firstList(queries) {
    let last = '';
    for (const q of queries) {
      try {
        const data = await this._get(q);
        const list = normalizeCats(data && data.js);
        if (list.length) return list;
      } catch (e) { last = e.message; }
    }
    if (last) this.profileError = this.profileError || last;
    return [];
  }

  async getCategories() {
    const tv = await this._firstList([
      { type: 'itv', action: 'get_genres', JsHttpRequest: '1-xml' }
    ]);
    const movies = await this._firstList([
      { type: 'vod', action: 'get_categories', JsHttpRequest: '1-xml' },
      { type: 'vod', action: 'get_genres', JsHttpRequest: '1-xml' }
    ]);
    const series = await this._firstList([
      { type: 'series', action: 'get_categories', JsHttpRequest: '1-xml' },
      { type: 'series', action: 'get_genres', JsHttpRequest: '1-xml' }
    ]);
    return { tv, movies, series };
  }

  async getChannels() {
    const data = await this._get({
      type: 'itv', action: 'get_all_channels', force_ch_link_check: '', JsHttpRequest: '1-xml'
    });
    return (data && data.js && data.js.data) || [];
  }

  async getVodList(categoryId, page = 1) {
    const data = await this._get({
      type: 'vod', action: 'get_ordered_list', category: categoryId, p: page, JsHttpRequest: '1-xml'
    });
    return (data && data.js && data.js.data) || [];
  }

  _cleanCmd(cmd) {
    if (!cmd) throw new Error('Portal não devolveu link');
    return String(cmd).trim().split(/\s+/).pop();
  }

  async createTvLink(cmd) {
    const data = await this._get({
      type: 'itv', action: 'create_link', cmd, series: '',
      forced_storage: '0', disable_ad: '0', download: '0', force_ch_link_check: '0',
      JsHttpRequest: '1-xml'
    });
    return this._cleanCmd(data && data.js && data.js.cmd);
  }

  async createVodLink(cmd) {
    const data = await this._get({
      type: 'vod', action: 'create_link', cmd, series: '',
      forced_storage: '0', disable_ad: '0', download: '0', JsHttpRequest: '1-xml'
    });
    return this._cleanCmd(data && data.js && data.js.cmd);
  }
}

module.exports = { StalkerClient };
