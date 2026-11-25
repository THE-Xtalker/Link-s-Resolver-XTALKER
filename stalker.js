const axios = require('axios');
const http = require('http');
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

const USER_AGENT =
  'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';

function normalizeMac(mac) {
  var hex = String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (hex.length !== 12) throw new Error('MAC inválido. Formato: 00:1A:79:XX:XX:XX');
  var out = '';
  for (var i = 0; i < 12; i += 2) {
    if (out) out += ':';
    out += hex.slice(i, i + 2);
  }
  return out;
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

  function ends(s, suffix) {
    return s.length >= suffix.length && s.slice(s.length - suffix.length).toLowerCase() === suffix;
  }

  var direct = [];
  if (ends(input, '/portal.php') || ends(input, '/server/load.php')) {
    direct.push(input);
    input = ends(input, '/portal.php') ? input.slice(0, -11) : input.slice(0, -16);
    while (input.charAt(input.length - 1) === '/') input = input.slice(0, -1);
  }
  if (ends(input, '/c')) input = input.slice(0, -2);
  while (input.charAt(input.length - 1) === '/') input = input.slice(0, -1);

  var bases = [input];
  if (!ends(input, '/stalker_portal')) bases.push(input + '/stalker_portal');

  var urls = direct.slice();
  for (var i = 0; i < bases.length; i++) {
    urls.push(bases[i] + '/portal.php');
    urls.push(bases[i] + '/server/load.php');
  }
  var uniq = [];
  for (var j = 0; j < urls.length; j++) {
    if (uniq.indexOf(urls[j]) === -1) uniq.push(urls[j]);
  }
  return uniq;
}

function parseBody(data) {
  if (data == null) return null;
  if (typeof data === 'object') return data;
  var text = String(data).replace(/^\uFEFF/, '').trim();
  if (!text) return null;
  if (text.charAt(0) !== '{' && text.charAt(0) !== '[') {
    if (/authorization failed|access denied|unauthorized/i.test(text)) throw new Error(text.slice(0, 180));
    throw new Error('Resposta inesperada: ' + text.slice(0, 140));
  }
  try { return JSON.parse(text); }
  catch (e) {
    var m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('JSON inválido do portal');
  }
}

function listFromJs(js) {
  if (!js) return [];
  if (Array.isArray(js)) return js;
  var data = js.data !== undefined ? js.data : js;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    return Object.keys(data).map(function (k) { return data[k]; }).filter(function (v) {
      return v && typeof v === 'object' && (v.name || v.cmd || v.id || v.title);
    });
  }
  return [];
}

function asList(js) {
  return listFromJs(js);
}

function normalizeCats(js) {
  var out = [];
  var seen = {};
  var items = asList(js);
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it || it.id === undefined || it.id === null || it.id === '*' || it.id === '') continue;
    var id = String(it.id);
    if (seen[id]) continue;
    seen[id] = true;
    out.push({ id: id, title: it.title || it.name || it.category_name || id });
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
    this.http = axios.create({ timeout: 20000, validateStatus: function () { return true; }, ...this._agents() });
  }

  _agents() {
    if (this.proxyUrl) {
      var agent = this.proxyUrl.indexOf('socks') === 0
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
    var parts = ['mac=' + this.mac, 'stb_lang=en', 'timezone=Europe/Lisbon'];
    var keys = Object.keys(this.cookies);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() !== 'mac') parts.push(keys[i] + '=' + this.cookies[keys[i]]);
    }
    var h = {
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
    var raw = res.headers && res.headers['set-cookie'];
    if (!raw) return;
    var list = Array.isArray(raw) ? raw : [raw];
    for (var n = 0; n < list.length; n++) {
      var pair = String(list[n]).split(';')[0];
      var i = pair.indexOf('=');
      if (i > 0) this.cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  }

  async _get(params) {
    var res = await this.http.get(this.endpoint, { params: params, headers: this._headers() });
    this._absorb(res);
    var preview = typeof res.data === 'string' ? res.data.slice(0, 200) : JSON.stringify(res.data).slice(0, 200);
    console.log('[STALKER] ' + res.status + ' ' + this.endpoint + ' ' + JSON.stringify(params) + ' ' + preview);
    if (res.status >= 400) throw new Error('HTTP ' + res.status);
    return parseBody(res.data);
  }

  async connect() {
    var errors = [];
    var endpoints = portalEndpoints(this.portalInput);
    for (var i = 0; i < endpoints.length; i++) {
      var endpoint = endpoints[i];
      try {
        this.endpoint = endpoint;
        this.referer = endpoint.replace('/portal.php', '/c/').replace('/server/load.php', '/c/');
        this.token = null;
        this.cookies = {};
        var data = await this._get({
          type: 'stb', action: 'handshake', token: '', prehash: 'false', JsHttpRequest: '1-0'
        });
        var token = data && data.js && data.js.token;
        if (!token) { errors.push(endpoint + ': sem token'); continue; }
        this.token = token;
        try { await this.getProfile(); }
        catch (e) { this.profileError = e.message; }
        console.log('[STALKER] ligado em ' + endpoint);
        return { endpoint: endpoint, token: token };
      } catch (e) {
        errors.push(endpoint + ': ' + e.message);
      }
    }
    throw new Error(errors.slice(0, 4).join(' | ') || 'Handshake falhou');
  }

  async getProfile() {
    var q = {
      type: 'stb', action: 'get_profile', hd: '1',
      num_banks: '2', stb_type: 'MAG250', client_type: 'STB',
      image_version: '218', video_out: 'hdmi', hw_version: '1.7-BD-00',
      not_valid_token: '0', auth_second_step: '1', JsHttpRequest: '1-0'
    };
    if (this.sn) q.sn = this.sn;
    if (this.deviceId) q.device_id = this.deviceId;
    if (this.deviceId2) q.device_id2 = this.deviceId2;
    if (this.signature) q.signature = this.signature;
    var data = await this._get(q);
    return data && data.js;
  }

  async _firstList(queries) {
    var last = '';
    for (var i = 0; i < queries.length; i++) {
      try {
        var data = await this._get(queries[i]);
        var list = normalizeCats(data && data.js);
        if (list.length) return list;
      } catch (e) { last = e.message; }
    }
    if (last) this.profileError = this.profileError || last;
    return [];
  }

  async getCategories() {
    var tv = await this._firstList([{ type: 'itv', action: 'get_genres', JsHttpRequest: '1-0' }]);
    var movies = await this._firstList([
      { type: 'vod', action: 'get_categories', JsHttpRequest: '1-0' },
      { type: 'vod', action: 'get_genres', JsHttpRequest: '1-0' }
    ]);
    var series = await this._firstList([
      { type: 'series', action: 'get_categories', JsHttpRequest: '1-0' },
      { type: 'series', action: 'get_genres', JsHttpRequest: '1-0' }
    ]);
    return { tv: tv, movies: movies, series: series };
  }

  async _ordered(type, query, page) {
    var q = { type: type, action: 'get_ordered_list', p: String(page || 1), JsHttpRequest: '1-0' };
    var extra = query || {};
    Object.keys(extra).forEach(function (k) { q[k] = extra[k]; });
    var data = await this._get(q);
    return listFromJs(data && data.js);
  }

  async getChannels(genreId = '*') {
  const url = `${this.portal}/server/load.php?type=itv&action=get_ordered_list&genre=${encodeURIComponent(genreId)}&p=1&JsHttpRequest=1-xml`;
  const r = await this.http.get(url);
  if (r.data && r.data.js) {
    return r.data.js.data || r.data.js;
  }
  return [];
}

async getVodList(categoryId, page = 1) {
  const url = `${this.portal}/server/load.php?type=vod&action=get_ordered_list&category=${encodeURIComponent(categoryId)}&p=${page}&JsHttpRequest=1-xml`;
  const r = await this.http.get(url);
  if (r.data && r.data.js) {
    return r.data.js.data || r.data.js;
  }
  return [];
}

  _cleanCmd(cmd) {
    if (!cmd) throw new Error('Portal não devolveu link');
    var url = String(cmd).trim();
    var prefixes = ['ffrt ', 'ffmpeg ', 'ffrt2 ', 'rtmp '];
    var low = url.toLowerCase();
    for (var i = 0; i < prefixes.length; i++) {
      if (low.indexOf(prefixes[i]) === 0) {
        url = url.slice(prefixes[i].length).trim();
        break;
      }
    }
    var bits = url.split(/\s+/);
    url = bits[bits.length - 1];
    if (url.indexOf('http') !== 0) throw new Error('Link sem http: ' + url.slice(0, 80));
    return url;
  }

  async createTvLink(cmd) {
    var data = await this._get({
      type: 'itv', action: 'create_link', cmd: cmd, series: '',
      forced_storage: '0', disable_ad: '0', download: '0', force_ch_link_check: '0',
      JsHttpRequest: '1-0'
    });
    return this._cleanCmd(data && data.js && (data.js.cmd || data.js));
  }

  async createVodLink(cmd) {
    var data = await this._get({
      type: 'vod', action: 'create_link', cmd: cmd, series: '',
      forced_storage: '0', disable_ad: '0', download: '0', JsHttpRequest: '1-0'
    });
    return this._cleanCmd(data && data.js && (data.js.cmd || data.js));
  }
}

module.exports = { StalkerClient };
