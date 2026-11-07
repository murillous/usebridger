// #region painel
import { definePlugin } from '@usebridger/core';

// Painel mínimo: uma página HTML que só conversa com a API do core (login, conexão e QR). O
// plugin apenas serve o arquivo; num app de verdade a página sai do build do seu frontend, na
// mesma origem do bot (ou em outra, com `api.cors`).
const html = `<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<title>Painel do bot</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 2rem auto; padding: 0 1rem; }
  form { display: grid; gap: .5rem; margin-bottom: 1.5rem; }
  [hidden] { display: none; }
  #erro { color: #b00020; }
</style>

<p id="erro"></p>

<section id="entrar" hidden>
  <h1>Entrar</h1>
  <form id="login">
    <input name="email" type="email" placeholder="e-mail" required>
    <input name="password" type="password" placeholder="senha" required>
    <button>Entrar</button>
  </form>
  <h2>Primeiro acesso</h2>
  <form id="primeiro">
    <input name="token" placeholder="token de primeiro acesso (terminal)" required>
    <input name="name" placeholder="seu nome" required>
    <input name="email" type="email" placeholder="e-mail" required>
    <input name="password" type="password" placeholder="senha" required>
    <button>Criar conta de owner</button>
  </form>
</section>

<section id="painel" hidden>
  <p>Olá, <b id="nome"></b>. <button id="sair">Sair</button></p>
  <h1>Conexão: <span id="status">…</span></h1>
  <p id="conta"></p>
  <div id="qr"></div>
</section>

<script type="module">
  import qrcode from 'https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/dist/qrcode.mjs';

  // Base da API da sessão \`default\`; outra sessão fica em /sessions/<nome>/api.
  const API = '/api';
  const $ = (id) => document.getElementById(id);

  // Escrita de browser com cookie leva X-Bridger-CSRF quando a API tem CORS (outra origem); na
  // mesma origem ele é dispensável, mas mandar sempre deixa a página pronta para os dois casos.
  async function api(path, body) {
    const res = await fetch(API + path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-bridger-csrf': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    // Todo erro da API é problem+json: \`detail\` diz o porquê, \`title\` é o nome do status.
    if (!res.ok) throw Object.assign(new Error(data.detail ?? data.title ?? res.statusText), { status: res.status });
    return data;
  }

  function mostrar(secao) {
    $('entrar').hidden = secao !== 'entrar';
    $('painel').hidden = secao !== 'painel';
  }

  async function atualizarConexao() {
    const c = await api('/connection');
    $('status').textContent = c.status;
    $('conta').textContent = c.account ? 'Conectado como ' + (c.account.name ?? c.account.id) : '';
    if (c.status === 'open') $('qr').replaceChildren();
  }

  let eventos;
  async function iniciar() {
    // /auth/me diz quem é a pessoa e o que ela pode: a navegação de um painel maior sai daqui.
    const me = await api('/auth/me');
    $('nome').textContent = me.name;
    mostrar('painel');
    await atualizarConexao();
    // O stream começa pelo estado atual (último status e o QR, se ainda vale) e retoma sozinho
    // com Last-Event-ID se a conexão cair. O QR só chega a quem tem connection.manage.
    eventos = new EventSource(API + '/events?types=connection.status,connection.qr', { withCredentials: true });
    eventos.addEventListener('connection.qr', (e) => {
      const qr = qrcode(0, 'L');
      qr.addData(JSON.parse(e.data).qr);
      qr.make();
      $('qr').innerHTML = qr.createSvgTag(4);
    });
    eventos.addEventListener('connection.status', () => atualizarConexao().catch(erro));
  }

  function erro(e) {
    $('erro').textContent = e.message;
  }

  function enviar(form, path) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      $('erro').textContent = '';
      api(path, Object.fromEntries(new FormData(form))).then(iniciar).catch(erro);
    });
  }
  enviar($('login'), '/auth/login');
  enviar($('primeiro'), '/auth/invites/accept');

  $('sair').addEventListener('click', () => {
    eventos?.close();
    api('/auth/logout', {}).then(() => mostrar('entrar')).catch(erro);
  });

  // Sem sessão, /auth/me responde 401: é o sinal para mostrar o login.
  iniciar().catch((e) => (e.status === 401 ? mostrar('entrar') : erro(e)));
</script>
</html>`;

export const painel = definePlugin({
  name: 'painel',
  version: '1.0.0',
  engine: '<1.0.0',
  setup(ctx) {
    // Fica em /plugins/painel. A rota é pública: quem protege os dados é a API, que pede login.
    ctx.http.route(
      'GET',
      '/',
      () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    );
  },
});
// #endregion painel
