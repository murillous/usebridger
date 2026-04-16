# Plano de Auto-Deploy — LumaBot

## Contexto

O LumaBot roda localmente com o dashboard gerenciando o bot como processo filho.
O Cloudflare Tunnel está vinculado ao processo do dashboard — não ao bot.
Reiniciar só o processo filho (bot) preserva a URL pública do tunnel.

**Objetivo:** push na `main` → código atualiza → só o bot reinicia → URL não muda.

---

## Entendimento do Problema

| Item | Detalhe |
|------|---------|
| Dashboard | Express + WebSocket + `spawn('node', ['index.js'])` |
| Bot | Processo filho do dashboard, gerenciado por `startBot()` / `restartBot()` / `stopBot()` |
| Tunnel | Processo separado no dashboard (`tunnelProcess`), URL muda só se o dashboard reiniciar |
| `restartBot()` | Já existe — mata o filho e respawna em 1.5s sem tocar no dashboard ou tunnel |

---

## Decisões de Design

| Decisão | Escolha | Alternativas descartadas | Motivo |
|---------|---------|--------------------------|--------|
| Mecanismo de trigger | Webhook do GitHub (`POST /api/deploy`) | Self-hosted runner, polling | Mais simples, zero infra extra |
| Autenticação do endpoint | HMAC-SHA256 (`x-hub-signature-256`) | Dashboard password, IP allowlist | Padrão do GitHub, seguro |
| `DEPLOY_SECRET` ausente | Endpoint desativado + aviso no log | Aceitar sem verificação | Segurança por padrão |
| Falha no deploy | Bot segue com código antigo | Parar o bot, rollback | Disponibilidade > consistência |
| Feedback | Apenas no log do dashboard | UI dedicada, notificações | YAGNI — log já existe |
| `npm install` | Só se `package.json` ou `package-lock.json` mudou | Sempre, nunca | Equilíbrio entre segurança e velocidade |
| Deploys paralelos | Git lock nativo resolve | Mutex, fila, debounce | Comportamento já correto sem código extra |
| Branch filter | Apenas `refs/heads/main` | Qualquer branch | Só produção faz deploy |

---

## Assumptions Confirmadas

- `git remote -v` e `git fetch origin main` funcionam no diretório do projeto ✅
- GitHub alcança o dashboard via URL pública do tunnel (`curl` retornou 401 esperado) ✅
- Dashboard tem permissão de leitura/escrita no diretório (já usa SQLite e auth_info) ✅

---

## Non-Goals

- Nenhuma UI nova no dashboard
- Sem rollback automático
- Sem notificações externas (email, Slack, etc.)
- Sem suporte a múltiplas branches

---

## Fluxo de Execução

```
push na main
    │
    ▼
GitHub envia POST /api/deploy
    │  header: x-hub-signature-256
    │  body:   JSON { ref, commits, ... }
    ▼
Verifica assinatura HMAC-SHA256 com DEPLOY_WEBHOOK_SECRET
    │
    ├─ inválida  → 401, pushLog('⚠️ Deploy: assinatura inválida')
    ├─ secret vazia → endpoint desativado, pushLog de aviso
    │
    └─ válida → 200 imediato (GitHub exige resposta em < 10s)
                │
                ▼ (assíncrono, após responder)
           git pull origin main
                │
                ├─ falhou → pushLog('❌ Deploy falhou: ...'), bot não reinicia
                │
                └─ ok → git diff HEAD~1 HEAD --name-only
                              │
                              ├─ package.json ou package-lock.json mudou
                              │       → npm install --omit=dev --no-audit
                              └─ não mudou → pula
                              │
                              ▼
                         pushLog('✅ Deploy concluído. Reiniciando bot...')
                         restartBot()
```

---

## Implementação

### 1. Variável de ambiente

Adicionar ao `.env`:

```env
DEPLOY_WEBHOOK_SECRET=uma_string_longa_e_aleatoria
```

Gerar um secret seguro:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2. `dashboard/server.js` — o que adicionar

**Imports** (junto aos existentes):
```js
import { spawn, execSync } from 'child_process';
import crypto from 'crypto';
```

**Constante** (junto às outras):
```js
const DEPLOY_SECRET = process.env.DEPLOY_WEBHOOK_SECRET || '';
```

**Capturar body bruto** (necessário para verificar assinatura HMAC — trocar o `express.json()` global):
```js
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
```

**Função de verificação de assinatura:**
```js
function verifyGitHubSignature(req) {
  const signature = req.headers['x-hub-signature-256'] || '';
  const expected  = 'sha256=' + crypto
    .createHmac('sha256', DEPLOY_SECRET)
    .update(req.rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

**Função de deploy** (antes das rotas):
```js
function runDeploy() {
  pushLog('🚀 Deploy iniciado (push na main)...', 'info');
  try {
    pushLog('📥 Executando git pull...', 'info');
    execSync('git pull origin main', { cwd: ROOT_DIR, timeout: 30000 });

    const changed = execSync('git diff HEAD~1 HEAD --name-only', { cwd: ROOT_DIR })
      .toString();

    if (changed.includes('package')) {
      pushLog('📦 Instalando dependências...', 'info');
      execSync('npm install --omit=dev --no-audit', { cwd: ROOT_DIR, timeout: 120000 });
    }

    pushLog('✅ Deploy concluído. Reiniciando bot...', 'success');
    restartBot();
  } catch (error) {
    pushLog(`❌ Deploy falhou: ${error.message}`, 'error');
  }
}
```

**Endpoint** (antes de `app.use(authMiddleware)` — tem auth própria):
```js
app.post('/api/deploy', (req, res) => {
  if (!DEPLOY_SECRET) {
    pushLog('⚠️ /api/deploy desativado — configure DEPLOY_WEBHOOK_SECRET no .env', 'warn');
    return res.status(503).json({ error: 'Deploy não configurado' });
  }

  if (!verifyGitHubSignature(req)) {
    pushLog('⚠️ Deploy: assinatura inválida — request rejeitado', 'warn');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.body.ref !== 'refs/heads/main') {
    return res.status(200).json({ ok: true, message: 'Branch ignorada' });
  }

  res.status(200).json({ ok: true, message: 'Deploy iniciado' });
  setImmediate(runDeploy);
});
```

### 3. Configurar webhook no GitHub

1. Repositório → **Settings** → **Webhooks** → **Add webhook**
2. **Payload URL:** `https://<sua-url>.trycloudflare.com/api/deploy`
3. **Content type:** `application/json`
4. **Secret:** mesmo valor de `DEPLOY_WEBHOOK_SECRET`
5. **Events:** apenas `push`
6. Salvar

### 4. Testar

Fazer um commit qualquer na main e observar o log do dashboard.
Para testar a assinatura antes do primeiro push real:

```bash
# Simula o webhook do GitHub localmente
curl -X POST http://localhost:3000/api/deploy \
  -H "Content-Type: application/json" \
  -H "x-hub-signature-256: sha256=$(echo -n '{"ref":"refs/heads/main"}' | openssl dgst -sha256 -hmac 'SEU_SECRET' | cut -d' ' -f2)" \
  -d '{"ref":"refs/heads/main"}'
```

---

## Risco Residual

| Risco | Probabilidade | Impacto | Mitigação |
|-------|--------------|---------|-----------|
| PC reinicia → URL do tunnel muda → webhook do GitHub aponta para URL antiga | Baixa (só em restart manual) | Médio | Atualizar webhook no GitHub após reiniciar o dashboard |
| Dois pushes simultâneos | Muito baixa | Baixo | Git lock nativo: segundo pull falha, bot já tem código do primeiro |
| `npm install` lento bloqueia o bot durante install | Baixa | Baixo | Bot reinicia só depois do install — código antigo roda até lá |
