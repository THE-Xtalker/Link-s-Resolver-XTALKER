function renderConfigPage() {
  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stalker Resolver — Configuração</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,Arial,sans-serif;background:#101014;color:#eee;margin:0;padding:24px}
  .wrap{max-width:640px;margin:0 auto}
  h1{margin:0 0 8px;font-size:22px}
  p.sub{color:#888;margin:0 0 20px}
  fieldset{border:1px solid #2a2a30;border-radius:10px;margin-bottom:16px;padding:14px}
  legend{padding:0 8px;color:#9aa}
  label{display:block;font-size:12px;color:#aaa;margin:8px 0 4px}
  input[type=text],input[type=url]{width:100%;padding:10px;border-radius:8px;border:1px solid #333;background:#1a1a20;color:#eee}
  button{cursor:pointer;border:none;border-radius:8px;padding:10px 16px;background:#7b5cff;color:#fff;font-weight:600}
  button:disabled{opacity:.5;cursor:not-allowed}
  .cats{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px}
  .cat-col{max-height:200px;overflow:auto;border:1px solid #2a2a30;border-radius:8px;padding:8px}
  .cat-col label{font-size:13px;color:#ddd;display:flex;gap:6px;margin:4px 0}
  #status{margin-top:12px;font-size:14px}
  .ok{color:#5f5}.err{color:#f66}
  #installBox{display:none;margin-top:20px;padding:16px;border:1px dashed #555;border-radius:10px}
  #installBox a{display:inline-block;margin-top:10px;padding:12px 20px;background:#22c55e;color:#fff;border-radius:8px;text-decoration:none;font-weight:700}
  code{background:#222;padding:4px 8px;border-radius:6px;font-size:12px;word-break:break-all;display:block;margin-top:8px;color:#9cd}
</style>
</head>
<body>
<div class="wrap">
  <h1>Stalker Resolver — Configuração</h1>
  <p class="sub">Introduz os dados do teu portal para gerar o addon.</p>

  <form id="form">
    <fieldset>
      <legend>Portal</legend>
      <label>Nome da Lista</label>
      <input type="text" name="listName" placeholder="Ex: Minha Lista" required>
      <label>URL do Servidor</label>
      <input type="url" name="portalUrl" placeholder="http://portal.exemplo.com/c/" required>
      <label>MAC Address</label>
      <input type="text" name="mac" placeholder="00:1A:79:XX:XX:XX" required>
    </fieldset>

    <fieldset>
      <legend>Identificadores (opcional)</legend>
      <label>SN</label><input type="text" name="sn">
      <label>Device ID 1</label><input type="text" name="deviceId">
      <label>Device ID 2</label><input type="text" name="deviceId2">
      <label>Signature</label><input type="text" name="signature">
    </fieldset>

    <fieldset>
      <legend>Proxy / VPN (opcional)</legend>
      <label>URL do Proxy</label>
      <input type="text" name="proxyUrl" placeholder="socks5://127.0.0.1:1080">
    </fieldset>

    <button type="button" id="btnValidate">🔗 Ligar e obter categorias</button>
    <div id="status"></div>

    <div id="catSection" style="display:none;margin-top:20px">
      <fieldset>
        <legend>Categorias de TV</legend>
        <div class="cat-col" id="tvCats"></div>
      </fieldset>
      <fieldset>
        <legend>Categorias de Filmes / Séries</legend>
        <div class="cat-col" id="vodCats"></div>
      </fieldset>
      <fieldset>
  <legend>Categorias de Séries</legend>
  <div class="cat-col" id="seriesCats"></div>
</fieldset>
      <button type="button" id="btnGenerate">⚙️ Gerar addon</button>
    </div>
  </form>

  <div id="installBox">
    <strong>✅ Addon pronto!</strong>
    <a id="installLink" href="#">Instalar no Stremio</a>
    <label style="margin-top:14px">Ou copia o URL:</label>
    <code id="installUrl"></code>
  </div>
</div>

<script>
const form = document.getElementById('form');
const statusEl = document.getElementById('status');
const catSection = document.getElementById('catSection');
const tvCatsEl = document.getElementById('tvCats');
const vodCatsEl = document.getElementById('vodCats');
const installBox = document.getElementById('installBox');

function formData() {
  const fd = Object.fromEntries(new FormData(form).entries());
  Object.keys(fd).forEach(k => { if (fd[k] === '') delete fd[k]; });
  return fd;
}

function renderCats(container, items) {
  const list = Array.isArray(items) ? items : [];
  container.innerHTML = '';
  if (!list.length) { container.textContent = '— nenhuma —'; return; }
  list.forEach(it => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = it.id;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + (it.title || it.id)));
    container.appendChild(label);
  });
}

document.getElementById('btnValidate').addEventListener('click', async () => {
  const btn = document.getElementById('btnValidate');
  btn.disabled = true;
  statusEl.textContent = 'A ligar ao portal… se o Render estiver adormecido, espera cerca de 1 minuto.';
  statusEl.className = '';
  catSection.style.display = 'none';
  installBox.style.display = 'none';
  try {
    const res = await fetch('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData())
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error('O servidor não respondeu JSON: ' + text.slice(0, 140)); }
    if (!data.ok) throw new Error(data.error || 'Falha desconhecida');
    renderCats(tvCatsEl, data.tvGenres);
    renderCats(vodCatsEl, data.vodGenres);
    if (document.getElementById('seriesCats')) renderCats(document.getElementById('seriesCats'), data.seriesGenres);
    const n = (data.tvGenres||[]).length + (data.vodGenres||[]).length + (data.seriesGenres||[]).length;
    statusEl.className = n ? 'ok' : 'err';
    statusEl.textContent = (n ? 'Ligado. ' : 'Ligado, mas 0 categorias. ')
      + 'TV ' + (data.tvGenres||[]).length
      + ' · Filmes ' + (data.vodGenres||[]).length
      + ' · Séries ' + (data.seriesGenres||[]).length
      + (data.profileError ? ' · aviso: ' + data.profileError : '')
      + ' · ' + data.endpoint;
    catSection.style.display = 'block';
  } catch (e) {
    statusEl.textContent = '❌ ' + e.message;
    statusEl.className = 'err';
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btnGenerate').addEventListener('click', () => {
  const cfg = formData();
  cfg.tvGenres = [...document.querySelectorAll('#tvCats input:checked')].map(i => i.value);
  cfg.vodGenres = [...document.querySelectorAll('#vodCats input:checked')].map(i => i.value);

  const const b64 = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(cfg)))));
  const origin = window.location.origin;
  const installUrl = origin + '/' + b64 + '/manifest.json';

  document.getElementById('installUrl').textContent = installUrl;
  const link = document.getElementById('installLink');
  link.href = installUrl.replace(/^https?:/, 'stremio:');
  installBox.style.display = 'block';
});
</script>
</body>
</html>`;
}

module.exports = { renderConfigPage };
