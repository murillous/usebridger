// #region pagina
import { createHmac } from 'node:crypto';
import { definePlugin } from '@usebridger/core';

// O token é o do seu sistema (ERP, site) provando quem é o usuário. Aqui o próprio exemplo o
// assina (HS256) para você não precisar de um sistema: em produção, quem assina é o seu backend.
function assinar(secret: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const corpo = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    sub: 'visitante',
    name: 'Visitante',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  return `${corpo}.${createHmac('sha256', secret).update(corpo).digest('base64url')}`;
}

// Página mínima do chat: abre o WebSocket do transport, autentica com o token e mostra as mensagens.
export function pagina(secret: string) {
  return definePlugin({
    name: 'pagina',
    version: '1.0.0',
    engine: '<1.0.0',
    setup(ctx) {
      // A rota fica em /plugins/pagina (a base do plugin é '/').
      ctx.http.route('GET', '/', () => {
        const html = `<!doctype html>
<meta charset="utf-8"><title>Meu primeiro bot</title>
<pre id="chat"></pre>
<form id="f"><input id="texto" autofocus placeholder="digite !ping"><button>Enviar</button></form>
<script>
  const log = (t) => (chat.textContent += t + '\\n');
  const ws = new WebSocket('ws://' + location.host + '/transports/web/chat');
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: '${assinar(secret)}' }));
  ws.onmessage = (e) => {
    const frame = JSON.parse(e.data);
    if (frame.type === 'message') log('bot: ' + frame.text);
  };
  f.onsubmit = (e) => {
    e.preventDefault();
    ws.send(JSON.stringify({ type: 'message', text: texto.value }));
    log('você: ' + texto.value);
    texto.value = '';
  };
</script>`;
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      });
    },
  });
}
// #endregion pagina
