const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

const USER_AGENT =
  'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';

class StalkerClient {
  constructor(cfg) {
    this.portal = (cfg.portalUrl || '').replace(/\/+$/, '');
    this.mac = cfg.mac || '';
    this.sn = cfg.sn || '';
    this.deviceId = cfg.deviceId || '';
    this.deviceId2 = cfg.deviceId2 || '';
    this.signature = cfg.signature || '';
    this.proxyUrl = cfg.proxyUrl || '';
    this.token = null;
    this.http = null;
    this._buildHttp();
  }

  _buildHttp() {
    const opts = {
      timeout: 20000,
      headers: this._headers(),
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
    const h = {
      'User-Agent': USER_AGENT,
      'X-User-Agent': 'Model: MAG250; Link: WiFi',
      Cookie: `mac=${encodeURIComponent(this.mac)}; stb_lang=en; timezone=Europe/London`,
      Referer: `${this.portal}/c/`
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async handshake() {
    const url = `${this.portal}/server/load.php?type=stb&action=handshake&token=&JsHttpRequest=1-xml`;
    const r = await this.http.get(url);
    const js = r.data && r.data.js;
    if (!js || !js.token) throw new Error('Handshake falhou (sem token)');
    this.token = js.token;
    this._buildHttp();
    return this.token;
  }

  async getProfile() {
    const metrics = encodeURIComponent(
      JSON.stringify({ mac: this.mac, sn: this.sn, model: 'MAG250', type: 'STB', uid: '', random: '' })
    );
    const qs = [
      'type=stb', 'action=get_profile', 'hd=1',
      'sn=' + encodeURIComponent(this.sn),
      'device_id=' + encodeURIComponent(this.deviceId),
      'device_id2=' + encodeURIComponent(this.deviceId2),
      'signature=' + encodeURIComponent(this.signature),
      'stb_type=MAG250', 'client_type=STB', 'image_version=218',
      'video_out=hdmi', 'hw_version=1.7-BD-00', 'not_valid_token=0',
      'auth_second_step=1', 'num_banks=2',
      'metrics=' + metrics,
      'JsHttpRequest=1-xml'
    ].join('&');
    const r = await this.http.get(`${this.portal}/server/load.php?${qs}`);
    return r.data && r.data.js;
  }

  async getGenres(type /* 'itv' | 'vod' */) {
    const url = `${this.portal}/server/load.php?type=${type}&action=get_genres&JsHttpRequest=1-xml`;
    const r = await this.http.get(url);
    return (r.data && r.data.js) || [];
  }

  async getVodCategories() {
    const url = `${this.portal}/server/load.php?type=vod&action=get_categories&JsHttpRequest=1-xml`;
    const r = await this.http.get(url);
    return (r.data && r.data.js) || [];
  }

  async getChannels() {
    const url = `${this.portal}/server/load.php?type=itv&action=get_all_channels&force_ch_link_check=&JsHttpRequest=1-xml`;
    const r = await this.http.get(url);
    return (r.data && r.data.js && r.data.js.data) || [];
  }

  async getVodList(categoryId, page = 1) {
    const url = `${this.portal}/server/load.php?type=vod&action=get_ordered_list&category=${categoryId}&p=${page}&JsHttpRequest=1-xml`;
    const r = await this.http.get(url);
    return (r.data && r.data.js && r.data.js.data) || [];
  }

  async createTvLink(cmd) {
    const url =
      `${this.portal}/server/load.php?type=itv&action=create_link` +
      `&cmd=${encodeURIComponent(cmd)}&series=&forced_storage=0` +
      `&disable_ad=0&download=0&force_ch_link_check=0&JsHttpRequest=1-xml`;
    const r = await this.http.get(url);
    const js = r.data && r.data.js;
    if (!js || !js.cmd) throw new Error('create_link falhou');
    return js.cmd.split(' ').pop();
  }

  async createVodLink(cmd) {
    const url =
      `${this.portal}/server/load.php?type=vod&action=create_link` +
      `&cmd=${encodeURIComponent(cmd)}&series=&forced_storage=0` +
      `&disable_ad=0&download=0&JsHttpRequest=1-xml`;
    const r = await this.http.get(url);
    const js = r.data && r.data.js;
    if (!js || !js.cmd) throw new Error('create_link VOD falhou');
    return js.cmd.split(' ').pop();
  }

  async ping() {
    try {
      await this.http.get(`${this.portal}/server/load.php?type=stb&action=get_events&event_active_id=0&init=1&JsHttpRequest=1-xml`);
    } catch (_) {}
  }
}

module.exports = { StalkerClient };
