# Changelog — LumaBot

## [6.1.0] — 2026-04-18

### Auto-Deploy via GitHub Webhook (`dashboard/server.js`)
- Novo endpoint `POST /api/deploy` com autenticação HMAC-SHA256 (`x-hub-signature-256`)
- Deploy só dispara para pushes em `refs/heads/main`; outras branches retornam 200 silencioso
- Lógica de debounce de 5 s: pushes em rajada viram um único deploy — só o estado mais recente é aplicado
- Sequência assíncrona pós-resposta: `git pull` → `npm install` condicional (só se `package.json` ou `package-lock.json` mudou) → `restartBot()`
- Endpoint desativado automaticamente quando `DEPLOY_WEBHOOK_SECRET` não está configurado

### Visão para Providers sem Suporte Multimodal (`LumaHandler`, `GeminiAdapter`, `AIProviderFactory`)
- `GeminiAdapter` ganha propriedade `supportsVision = true`; wrapper OpenAI/DeepSeek ganha `supportsVision = false`
- `LumaHandler` cria automaticamente um `GeminiAdapter` secundário (`visionService`) quando o provider principal não suporta visão e `GEMINI_API_KEY` está disponível
- Quando chega uma imagem: Gemini descreve em português → descrição injetada no prompt como texto → imagem em base64 nunca chega ao DeepSeek

### Migração `AIService` → `GeminiAdapter` (`AIProviderFactory`)
- `createAIProvider` agora instancia `GeminiAdapter` para o provider `gemini` em vez do `AIService` legado
- `AIService.js` removido (código era duplicata exata do `GeminiAdapter` sem extensão de `AIPort`)
- Testes de `AIProviderFactory` e `MessageHandler` atualizados para mockar `GeminiAdapter`

### Reconexão após Logout Manual (`ReconnectionPolicy`)
- Corrigido bug de ordem de verificação: `errorMessage.includes('Connection Failure')` era avaliado antes de `isAuthenticationError(statusCode)`
- Status 401 com mensagem `"Connection Failure"` (logout do celular) agora retorna `clean_and_restart` → limpa `auth_info` → exibe QR code
- Antes: entrava em loop infinito de `retry_connection`

### Remoção Aleatória no Grupo (`ToolDispatcher`)
- Quando `remove_member` é acionado sem alvo identificável (sem menção, sem número válido), a Luma sorteia um membro não-admin (excluindo ela mesma e quem pediu)
- Mensagem de kick no sorteio não revela que foi aleatório: `"Já sabia que era você, @fulano. Tchau 👋"`

### Contexto de Grupo — Limpeza com `!lc` (`LumaPlugin`)
- `!luma clear` agora também apaga o `#groupBuffer` do grupo além do `ConversationHistory`
- Antes: limpar o histórico não impedia que o contexto recente do grupo influenciasse respostas subsequentes

### Limite de Caracteres Repetidos (`ResponseFormatter`)
- `cleanResponseText` agora colapsa sequências de caracteres repetidos acima de 30 para exatamente 30
- Evita que respostas como `"kkkkkkk..."` se partam em múltiplas mensagens de spam

### Contexto Temporal no Prompt (`PromptBuilder`, `lumaConfig`)
- Data e hora de Brasília (`America/Sao_Paulo`) injetadas em todo prompt via placeholder `{{CURRENT_DATETIME}}`
- Formato: `"sexta-feira, 18 de abril de 2026 às 15:34"` — recalculado a cada mensagem

### Dashboard — Botão de Filtro INFO (`styles.css`)
- Adicionadas regras `.filter-btn.info`, `.filter-btn.info:hover` e `.filter-btn.info.active`
- Botão INFO agora usa `--c-cyan` (`#44eeff`), alinhado visualmente com a cor dos logs `INFO`

---

## [6.0.0] — versão anterior

Arquitetura hexagonal com Ports & Adapters, Plugin System e Injeção de Dependências.
