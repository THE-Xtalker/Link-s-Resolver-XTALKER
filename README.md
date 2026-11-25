# Stalker Resolver — Stremio Addon

Addon que resolve links de portais Stalker/Ministra no Stremio.

## Deploy no Render
1. Faz push deste repositório para o GitHub.
2. No Render: **New → Web Service** → conecta o repo.
3. O `render.yaml` é detetado automaticamente. Confirma:
   - Runtime: Node
   - Build: `npm install`
   - Start: `npm start`
4. Deploy.

## Configuração
Acede a `https://o-teu-addon.onrender.com/configure`, preenche os dados do portal e clica em **Instalar no Stremio**.

## Notas
- Plano free do Render hiberna após 15 min. Usa UptimeRobot em `/health` para manter ativo.
- O addon **não faz proxy do vídeo** — só resolve o link.
