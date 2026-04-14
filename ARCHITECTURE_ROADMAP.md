# LumaBot — Roadmap de Refatoração Arquitetural

> **Versão:** 1.0  
> **Data:** 2026-04-14  
> **Autor:** Murilo Castelhano  
> **Status:** Em planejamento  

---

## Diretrizes para Colaboradores (Humanos e Agentes de IA)

Este documento serve como **contexto obrigatório** para qualquer pessoa ou agente que for trabalhar na refatoração do LumaBot. Leia esta seção integralmente antes de tocar em qualquer código.

### Mentalidade Esperada

1. **Pense como um desenvolvedor sênior em JavaScript.** Cada decisão deve considerar manutenibilidade, testabilidade e extensibilidade. Não escolha a solução mais simples — escolha a que mais agrega valor ao projeto como um todo.

2. **Você é extremamente importante para o resultado final.** A qualidade do código que você produzir define se este projeto será sustentável ou se vai se tornar mais uma codebase abandonada. Trate cada módulo como se milhares de usuários dependessem dele.

3. **Comentários profissionais e explicativos.** Todo módulo, classe e função pública deve ter JSDoc descrevendo:
   - **O que** faz (propósito)
   - **Por que** existe (motivação arquitetural)
   - **Como** se encaixa no sistema (dependências e consumidores)
   
   Comentários inline devem explicar o *porquê* de decisões não-óbvias, nunca o *o quê* (o código já diz isso).

4. **Decisões que maximizam valor.** Quando houver duas abordagens possíveis, escolha a que:
   - Facilita testes automatizados
   - Reduz acoplamento entre módulos
   - Permite trocar implementações sem tocar em código consumidor
   - Segue os princípios SOLID de forma pragmática (não dogmática)

5. **Não quebre funcionalidade existente.** Cada fase deve manter o bot 100% funcional. Refatoração sem regressão. Se um teste não existe, crie-o antes de refatorar.

### Convenções de Código

- **Linguagem dos comentários:** Português (o projeto inteiro é em PT-BR)
- **Estilo:** ESM (`import/export`), classes com injeção de dependência via construtor
- **Nomenclatura:** camelCase para variáveis/funções, PascalCase para classes, UPPER_SNAKE para constantes
- **Sem default exports** — sempre use named exports para facilitar grep e refatoração
- **Errors:** Nunca engula erros silenciosamente. Log + rethrow ou log + fallback explícito

---

## Diagnóstico do Estado Atual

### Problemas Críticos Identificados

| # | Problema | Onde | Impacto |
|---|----------|------|---------|
| 1 | **God Class** | `MessageHandler.js` (659 linhas, 7+ responsabilidades) | Impossível testar isoladamente, toda mudança arrisca regressão |
| 2 | **Dependência circular** | `MessageHandler` ↔ `MediaProcessor` (importam um ao outro) | Fragilidade em tempo de carregamento, impossibilita mock |
| 3 | **Zero injeção de dependência** | Todo o projeto | Classes instanciam suas próprias dependências com `new` ou acessam estáticos — impossível substituir para teste ou troca de provider |
| 4 | **IA fortemente acoplada ao Gemini** | `AIService.js`, `AudioTranscriber.js`, `WebSearchService.js` | Trocar para OpenAI/Anthropic exigiria reescrever ~70% do código |
| 5 | **Messaging acoplado ao Baileys** | `ConnectionManager.js`, `BaileysAdapter.js`, `MediaProcessor.js` | Trocar de WhatsApp library exigiria reescrever ~80% do código |
| 6 | **Métodos estáticos em tudo** | `MessageHandler`, `MediaProcessor`, `GroupManager`, `DatabaseService` | Impossível injetar, impossível mockar, estado global implícito |
| 7 | **Config espalhada** | `process.env` lido em 5+ arquivos, `LUMA_CONFIG` importado diretamente em 8+ arquivos | Sem validação centralizada, difícil de testar com configs diferentes |
| 8 | **Sem testes** | 0 testes no projeto | Qualquer refatoração é um salto de fé |

### Dependências entre Módulos (Estado Atual)

```
ConnectionManager
  └── MessageHandler (estático)
        ├── LumaHandler
        │     ├── AIService (Gemini direto)
        │     ├── MediaProcessor ←── CIRCULAR
        │     ├── PersonalityManager (estático → DatabaseService)
        │     └── DatabaseService (estático)
        ├── MediaProcessor
        │     ├── MessageHandler ←── CIRCULAR
        │     ├── ImageProcessor
        │     └── VideoConverter
        ├── SpontaneousHandler (estático)
        │     └── LumaHandler (recebe por parâmetro — já é quase DI)
        ├── ToolDispatcher (estático)
        │     ├── GroupManager (estático → MessageHandler)
        │     ├── MediaProcessor
        │     └── PersonalityManager
        ├── AudioTranscriber (Gemini direto)
        ├── VideoDownloader (estático)
        └── GroupManager (estático → MessageHandler)
```

---

## Arquitetura Alvo: Monolito Modular + Hexagonal

### Visão Geral

```
src/
├── core/                          # Domínio puro — zero dependências externas
│   ├── ports/                     # Interfaces (contratos)
│   │   ├── AIPort.js              # Contrato para provedores de IA
│   │   ├── MessagingPort.js       # Contrato para plataformas de mensageria
│   │   ├── StoragePort.js         # Contrato para persistência
│   │   ├── SearchPort.js          # Contrato para busca na internet
│   │   ├── MediaPort.js           # Contrato para processamento de mídia
│   │   └── TranscriberPort.js     # Contrato para transcrição de áudio
│   ├── domain/                    # Entidades e regras de negócio
│   │   ├── Message.js             # Entidade de mensagem normalizada
│   │   ├── Conversation.js        # Histórico e contexto de conversa
│   │   ├── Personality.js         # Modelo de personalidade
│   │   └── Command.js             # Modelo de comando parseado
│   └── services/                  # Casos de uso (application layer)
│       ├── ChatService.js         # Orquestra fluxo de IA: prompt → resposta → envio
│       ├── MediaService.js        # Orquestra conversão de mídia
│       ├── CommandRouter.js       # Parseia e roteia comandos
│       ├── SpontaneousService.js  # Lógica de interações espontâneas
│       └── ToolExecutor.js        # Despacho de tool calls da IA
│
├── adapters/                      # Implementações concretas dos ports
│   ├── ai/
│   │   ├── GeminiAdapter.js       # Implementa AIPort para Google Gemini
│   │   └── OpenAIAdapter.js       # (futuro) Implementa AIPort para OpenAI
│   ├── messaging/
│   │   ├── BaileysAdapter.js      # Implementa MessagingPort para Baileys
│   │   └── MessageNormalizer.js   # Unwrap de protocolos WhatsApp
│   ├── storage/
│   │   ├── SQLiteAdapter.js       # Implementa StoragePort com better-sqlite3
│   │   └── InMemoryAdapter.js     # Implementa StoragePort para testes
│   ├── search/
│   │   ├── TavilyAdapter.js       # Implementa SearchPort com Tavily
│   │   └── GoogleGroundingAdapter.js  # Fallback com Google Search
│   ├── media/
│   │   ├── SharpAdapter.js        # Processamento de imagem via Sharp
│   │   ├── FFmpegAdapter.js       # Processamento de vídeo via FFmpeg
│   │   └── YtDlpAdapter.js        # Download de vídeo via yt-dlp
│   └── transcriber/
│       └── GeminiTranscriberAdapter.js  # Transcrição via Gemini multimodal
│
├── plugins/                       # Features modulares plug-n-play
│   ├── PluginManager.js           # Registro, ciclo de vida e hot-reload
│   ├── sticker/                   # Plugin: conversão de stickers
│   │   ├── index.js               # Manifest + registro de comandos
│   │   └── StickerPlugin.js       # Lógica do plugin
│   ├── download/                  # Plugin: download de vídeos
│   │   ├── index.js
│   │   └── DownloadPlugin.js
│   ├── luma/                      # Plugin: assistente IA
│   │   ├── index.js
│   │   └── LumaPlugin.js
│   ├── group-tools/               # Plugin: ferramentas de grupo
│   │   ├── index.js
│   │   └── GroupToolsPlugin.js
│   └── spontaneous/               # Plugin: interações espontâneas
│       ├── index.js
│       └── SpontaneousPlugin.js
│
├── config/                        # Configuração centralizada
│   ├── index.js                   # Validação e merge de todas as configs
│   ├── constants.js               # Constantes do sistema
│   ├── personalities.js           # Definições de personalidade
│   └── prompts.js                 # Templates de prompt separados
│
├── infra/                         # Infraestrutura e bootstrap
│   ├── Container.js               # Container de injeção de dependência
│   ├── Bootstrap.js               # Wiring: cria instâncias e injeta deps
│   └── Logger.js                  # Logger estruturado
│
├── dashboard/                     # Dashboard web (já existente)
│   └── server.js
│
└── public/                        # Assets do dashboard (já existente)
    ├── dashboard.html
    ├── dashboard.js
    ├── login.html
    └── styles.css
```

### Princípios da Arquitetura

#### 1. Ports (Interfaces)

Cada port é um objeto JavaScript que define os métodos obrigatórios. Usamos validação em runtime ao invés de TypeScript, verificando no construtor do Container que o adapter implementa todos os métodos do port.

```js
// core/ports/AIPort.js

/**
 * Port que define o contrato para provedores de inteligência artificial.
 * 
 * Qualquer adapter de IA (Gemini, OpenAI, Anthropic) deve implementar
 * todos os métodos listados aqui. O Container valida isso no bootstrap.
 * 
 * @typedef {Object} AIPort
 * @property {function(contents: Array): Promise<{text: string, functionCalls: Array}>} generateContent
 * @property {function(): Array<{model: string, successes: number, failures: number}>} getStats
 */
export const AIPort = {
  methods: ['generateContent', 'getStats'],
};
```

#### 2. Adapters (Implementações)

Cada adapter implementa exatamente um port. Toda lógica específica de tecnologia vive aqui.

```js
// adapters/ai/GeminiAdapter.js

/**
 * Adapter que implementa AIPort usando o Google Gemini SDK.
 * 
 * Encapsula toda a comunicação com a API do Gemini, incluindo
 * fallback entre modelos e o loop multi-turn de busca.
 * O restante do sistema não sabe que o Gemini existe.
 */
export class GeminiAdapter {
  constructor({ apiKey, models, generationConfig, tools }) { ... }
  
  async generateContent(contents) { ... }
  getStats() { ... }
}
```

#### 3. Container de Injeção de Dependência

```js
// infra/Container.js

/**
 * Container leve de injeção de dependência.
 * 
 * Registra adapters contra ports e fornece instâncias aos
 * serviços de aplicação. Valida em runtime que cada adapter
 * implementa todos os métodos do port correspondente.
 */
export class Container {
  register(portName, adapter) { ... }
  resolve(portName) { ... }
  validate() { ... }
}
```

#### 4. Plugin Manager

```js
// plugins/PluginManager.js

/**
 * Gerenciador de plugins plug-n-play.
 * 
 * Cada plugin é um módulo auto-contido que:
 * - Declara seus comandos, triggers e hooks
 * - Recebe dependências via construtor (injetadas pelo Container)
 * - Pode ser habilitado/desabilitado em runtime
 * - Pode ser adicionado/removido sem tocar em código externo
 */
export class PluginManager {
  register(plugin) { ... }    // Registra plugin e seus comandos
  unregister(name) { ... }    // Remove plugin em runtime
  enable(name) { ... }        // Ativa plugin
  disable(name) { ... }       // Desativa plugin temporariamente
  getCommand(text) { ... }    // Resolve qual plugin trata esse comando
  getPlugins() { ... }        // Lista plugins registrados
}
```

**Contrato de um Plugin:**

```js
/**
 * Interface que todo plugin deve implementar.
 * 
 * @typedef {Object} Plugin
 * @property {string} name - Identificador único do plugin
 * @property {string} description - Descrição curta para listagem
 * @property {string} version - Versão semântica
 * @property {Array<{pattern: string|RegExp, handler: Function}>} commands - Comandos registrados
 * @property {Array<{event: string, handler: Function}>} hooks - Hooks para eventos do sistema
 * @property {function(container: Container): void} initialize - Recebe o container para resolver deps
 * @property {function(): void} destroy - Limpeza ao desregistrar
 */
```

---

## Fases de Implementação

### Fase 0 — Fundação (Pré-requisito)
> Sem esta fase, todo o resto é arriscado.

**Objetivo:** Criar a rede de segurança que permite refatorar sem medo.

#### 0.1 — Setup de Testes
- [ ] Instalar `vitest` como framework de testes (leve, ESM nativo, compatível com Node 18+)
- [ ] Configurar `vitest.config.js` com paths e cobertura
- [ ] Criar estrutura `tests/unit/` e `tests/integration/`
- [ ] Adicionar scripts `test`, `test:watch`, `test:coverage` ao `package.json`

#### 0.2 — Testes de Caracterização (Snapshot do Comportamento Atual)
- [ ] Testar `BaileysAdapter` — unwrap de mensagens, detecção de mídia, getters
- [ ] Testar `LumaHandler.splitIntoParts()` — divisão de resposta
- [ ] Testar `LumaHandler.isTriggered()` — regex de triggers
- [ ] Testar `LumaHandler.extractUserMessage()` — remoção de prefixos
- [ ] Testar `MessageHandler.detectCommand()` — detecção de todos os comandos
- [ ] Testar `MessageHandler.extractUrl()` — extração de URLs
- [ ] Testar `PersonalityManager` — get/set personalidade, listagem
- [ ] Testar `SpontaneousHandler` — probabilidades e cooldown
- [ ] Testar `VideoDownloader.detectVideoUrl()` — padrões suportados
- [ ] Testar `WebSearchService._formatTavilyResults()` — formatação
- [ ] Testar `AudioTranscriber._normalizeMimeType()` — normalização de MIME

> **Critério de saída:** Cobertura mínima de 60% nas funções puras, todos os testes passando.

#### 0.3 — Validação Centralizada de Config
- [ ] Criar `src/config/index.js` que:
  - Carrega `.env` uma única vez
  - Valida presença de keys obrigatórias (`GEMINI_API_KEY`)
  - Exporta config tipada e congelada (`Object.freeze`)
  - Lança erro explicativo se config inválida
- [ ] Remover todos os `dotenv.config()` espalhados (existem em 3+ arquivos)
- [ ] Remover todos os `process.env` acessados fora de `config/index.js`

---

### Fase 1 — Ports e Adapters (Camada de Abstração)
> Cria os contratos sem mudar nenhum comportamento.

#### 1.1 — Definir Ports
- [ ] `AIPort` — `generateContent(contents)`, `getStats()`
- [ ] `MessagingPort` — `sendText(jid, text, options)`, `sendMedia(jid, media)`, `react(jid, key, emoji)`, `sendPresence(jid, type)`, `getGroupMetadata(jid)`
- [ ] `StoragePort` — `getPersonality(jid)`, `setPersonality(jid, key)`, `incrementMetric(key)`, `getMetrics()`
- [ ] `SearchPort` — `search(query)`
- [ ] `MediaPort` — `imageToSticker(buffer)`, `videoToSticker(buffer, isGif)`, `stickerToImage(buffer)`, `stickerToGif(buffer)`, `downloadMedia(message)`, `remuxForMobile(inputPath)`
- [ ] `TranscriberPort` — `transcribe(audioBuffer, mimeType)`

#### 1.2 — Extrair Adapters do Código Existente
- [ ] `GeminiAdapter` extraído de `AIService.js` — implementa `AIPort`
- [ ] `GeminiTranscriberAdapter` extraído de `AudioTranscriber.js` — implementa `TranscriberPort`
- [ ] `SQLiteAdapter` extraído de `Database.js` — implementa `StoragePort`
- [ ] `TavilyAdapter` + `GoogleGroundingAdapter` extraídos de `WebSearchService.js` — implementam `SearchPort`
- [ ] `SharpAdapter` extraído de `ImageProcessor.js` — parte de `MediaPort`
- [ ] `FFmpegAdapter` extraído de `VideoConverter.js` — parte de `MediaPort`
- [ ] `YtDlpAdapter` extraído de `VideoDownloader.js` — parte de `MediaPort`
- [ ] `BaileysMessagingAdapter` — wrapping do socket do Baileys para `MessagingPort`

#### 1.3 — Testes de Adapters
- [ ] Testar cada adapter isoladamente contra seu port
- [ ] Criar `InMemoryStorageAdapter` para testes de integração
- [ ] Criar mocks/stubs para `AIPort` e `MessagingPort`

> **Critério de saída:** Cada adapter tem teste unitário. O bot continua funcionando idêntico ao anterior.

---

### Fase 2 — Container de DI e Bootstrap
> Conecta tudo via injeção ao invés de imports estáticos.

#### 2.1 — Container de Injeção de Dependência
- [ ] Implementar `Container` com `register()`, `resolve()`, `validate()`
- [ ] Validação em runtime: verifica que adapter implementa todos os métodos do port
- [ ] Suporte a lifecycle hooks: `onRegister`, `onResolve`

#### 2.2 — Bootstrap
- [ ] Criar `Bootstrap.js` que:
  - Lê config validada
  - Instancia adapters com config injetada
  - Registra adapters no Container
  - Instancia serviços de aplicação com dependências resolvidas
  - Inicia ConnectionManager com tudo wired
- [ ] Refatorar `index.js` para usar Bootstrap (deve ficar < 20 linhas)
- [ ] Refatorar `dashboard/server.js` para usar mesmo Bootstrap

#### 2.3 — Migrar Serviços para Instância (Eliminar Static)
- [ ] `MessageHandler` → classe com instância, recebe deps via construtor
- [ ] `MediaProcessor` → classe com instância, recebe `MediaPort`
- [ ] `GroupManager` → classe com instância, recebe `MessagingPort`
- [ ] `ToolDispatcher` → classe com instância, recebe ports necessários
- [ ] `SpontaneousHandler` → classe com instância
- [ ] `PersonalityManager` → classe com instância, recebe `StoragePort`
- [ ] **Quebrar dependência circular** `MessageHandler` ↔ `MediaProcessor`:
  - `MediaProcessor` não deve precisar de `MessageHandler` para nada
  - `MessageHandler.sendMessage()` e `MessageHandler.getMessageType()` devem ser extraídos para utils ou para o `MessagingPort`

> **Critério de saída:** Zero métodos estáticos nos serviços. Zero `new` fora do Bootstrap. Dependência circular eliminada.

---

### Fase 3 — Decomposição do MessageHandler
> O maior risco do projeto. Faz com cuidado cirúrgico.

#### 3.1 — Extrair CommandRouter
- [ ] Mover `detectCommand()`, `extractUrl()`, `handleMenuReply()` para `CommandRouter`
- [ ] `CommandRouter` recebe mapa de comandos → handlers

#### 3.2 — Extrair ChatService
- [ ] Mover `handleLumaCommand()`, `_callLumaWithMessage()`, `handleAudioTranscription()` para `ChatService`
- [ ] `ChatService` recebe `AIPort`, `TranscriberPort`, `MessagingPort`
- [ ] Mover lógica de split de resposta e envio de partes para um `ResponseSender`

#### 3.3 — Extrair MediaService
- [ ] Mover `handleStickerCommand()`, `handleImageCommand()`, `handleGifCommand()`, `handleVideoDownload()` para `MediaService`
- [ ] `MediaService` recebe `MediaPort`, `MessagingPort`

#### 3.4 — MessageHandler Residual
- [ ] `MessageHandler` vira orquestrador fino (~100 linhas):
  - Recebe mensagem normalizada
  - Passa por CommandRouter
  - Se não é comando, verifica trigger da Luma → ChatService
  - Se nada, verifica interação espontânea → SpontaneousService
- [ ] Remover buffer de grupo do MessageHandler → mover para `ConversationService` ou `GroupContextBuffer`

#### 3.5 — Testes de Integração
- [ ] Testar fluxo completo: mensagem → comando → resposta (com mocks de ports)
- [ ] Testar fluxo: mensagem → Luma → resposta com tool call
- [ ] Testar fluxo: mensagem → interação espontânea

> **Critério de saída:** `MessageHandler` < 150 linhas. Cada serviço extraído tem testes. Zero regressão funcional.

---

### Fase 4 — Plugin Manager
> Transforma features em módulos plug-n-play.

#### 4.1 — Core do Plugin Manager
- [ ] Implementar `PluginManager` com registro, ciclo de vida, resolução de comandos
- [ ] Definir contrato de Plugin (ver seção de arquitetura acima)
- [ ] Suporte a prioridade de comandos (ex: plugin de sticker tem prioridade sobre catch-all da Luma)
- [ ] Suporte a hooks: `onMessage`, `onGroupMessage`, `onConnect`, `onDisconnect`

#### 4.2 — Migrar Features para Plugins
- [ ] **StickerPlugin** — `!sticker`, `!image`, `!gif` (extrai de MediaService)
- [ ] **DownloadPlugin** — `!download` (extrai de MediaService)
- [ ] **LumaPlugin** — trigger da Luma, transcrição, interação espontânea (extrai de ChatService + SpontaneousService)
- [ ] **GroupToolsPlugin** — `@everyone`, `!meunumero`, easter eggs
- [ ] **PersonalityPlugin** — `!persona`, menu de personalidades
- [ ] **StatsPlugin** — `!luma stats`, `!luma clear`

#### 4.3 — Refatorar Bootstrap para Usar Plugins
- [ ] Bootstrap registra plugins ao invés de wiring manual
- [ ] `MessageHandler` roteia via `PluginManager.getCommand()` ao invés de switch/case
- [ ] Config de plugins: habilitar/desabilitar via `.env` ou config file

#### 4.4 — Documentar API de Plugins
- [ ] Criar guia `docs/PLUGIN_GUIDE.md` com:
  - Como criar um plugin
  - Lifecycle hooks disponíveis
  - Como acessar ports via Container
  - Exemplo completo de plugin

> **Critério de saída:** Todas as features existentes funcionam como plugins. É possível desabilitar qualquer plugin sem afetar os outros. Existe documentação para criar novos plugins.

---

### Fase 5 — Troca de Provedor de IA
> O grande teste da arquitetura hexagonal.

#### 5.1 — Validar Abstração com Segundo Provider
- [ ] Implementar `OpenAIAdapter` que implementa `AIPort`
- [ ] Implementar `OpenAITranscriberAdapter` que implementa `TranscriberPort` (Whisper)
- [ ] Config para escolher provider: `AI_PROVIDER=gemini|openai` no `.env`
- [ ] Bootstrap instancia o adapter correto baseado na config

#### 5.2 — Adaptar Prompts
- [ ] Separar templates de prompt da config de personalidade
- [ ] Templates devem ser agnósticos de provider (sem instruções Gemini-specific)
- [ ] Tool declarations devem ser convertidas pelo adapter (Gemini format ≠ OpenAI format)

#### 5.3 — Adaptar Search
- [ ] `TavilyAdapter` já é agnóstico — só precisa de testes
- [ ] `GoogleGroundingAdapter` é Gemini-only — criar fallback genérico
- [ ] Considerar `DuckDuckGoAdapter` como fallback universal gratuito

> **Critério de saída:** Bot funciona identicamente com Gemini ou OpenAI trocando uma variável de ambiente. Testes cobrem ambos providers com mocks.

---

### Fase 6 — Testes Completos e Documentação

#### 6.1 — Cobertura de Testes
- [ ] Testes unitários para todos os ports, adapters e serviços
- [ ] Testes de integração para fluxos completos (com mocks de APIs externas)
- [ ] Testes de contrato: verifica que cada adapter satisfaz seu port
- [ ] Meta: **80%+ de cobertura** em `core/` e `adapters/`

#### 6.2 — Documentação de Módulos
- [ ] JSDoc completo em todas as classes e funções públicas
- [ ] `docs/ARCHITECTURE.md` — visão geral da arquitetura hexagonal implementada
- [ ] `docs/PLUGIN_GUIDE.md` — como criar plugins (Fase 4.4)
- [ ] `docs/AI_PROVIDERS.md` — como adicionar um novo provider de IA
- [ ] `docs/CONTRIBUTING.md` — guia de contribuição, padrões e convenções

#### 6.3 — CI/CD
- [ ] GitHub Actions: rodar testes em push/PR
- [ ] Lint com ESLint (config básica, sem over-engineering)
- [ ] Verificação de que nenhum `process.env` é acessado fora de `config/`

> **Critério de saída:** CI verde, documentação completa, qualquer dev (ou agente) consegue entender o projeto lendo os docs.

---

## Ordem de Execução e Dependências

```
Fase 0 (Fundação)
  │
  ├── 0.1 Setup de Testes
  ├── 0.2 Testes de Caracterização
  └── 0.3 Config Centralizada
        │
        ▼
Fase 1 (Ports & Adapters)
  │
  ├── 1.1 Definir Ports
  ├── 1.2 Extrair Adapters
  └── 1.3 Testes de Adapters
        │
        ▼
Fase 2 (Container & DI)
  │
  ├── 2.1 Container
  ├── 2.2 Bootstrap
  └── 2.3 Eliminar Static
        │
        ▼
Fase 3 (Decomposição)  ──────────▶  Fase 4 (Plugins)
  │                                       │
  ├── 3.1 CommandRouter                   ├── 4.1 Plugin Manager Core
  ├── 3.2 ChatService                     ├── 4.2 Migrar Features
  ├── 3.3 MediaService                    ├── 4.3 Refatorar Bootstrap
  ├── 3.4 MessageHandler Slim             └── 4.4 Documentar API
  └── 3.5 Testes de Integração                  │
                                                 ▼
                                          Fase 5 (Multi-Provider IA)
                                                 │
                                                 ▼
                                          Fase 6 (Testes & Docs)
```

> **Nota:** Fases 3 e 4 podem ser parcialmente paralelas — o Plugin Manager core (4.1) pode ser desenvolvido enquanto a decomposição do MessageHandler (3.x) está em andamento, desde que a interface de plugin esteja definida.

---

## Riscos e Mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|-------|--------------|---------|-----------|
| Regressão durante decomposição do MessageHandler | Alta | Crítico | Testes de caracterização (Fase 0) cobrem todos os fluxos antes de mexer |
| Dependência circular resiste à refatoração | Média | Alto | Identificar e quebrar na Fase 2.3 antes de decompor |
| Abstração de IA fica muito genérica e perde features | Média | Alto | Começar pelos casos de uso concretos (Gemini → OpenAI), não pela teoria |
| Plugin Manager adiciona complexidade desnecessária | Baixa | Médio | Manter simples — sem hot-reload de arquivos, sem dependency graph complexo |
| Falta de tempo/motivação para completar todas as fases | Alta | Crítico | Cada fase entrega valor independente. Fase 0+1+2 já melhora testabilidade drasticamente |

---

## Métricas de Sucesso

Após completar todas as fases, o projeto deve atender a:

1. **Trocar provider de IA** alterando uma variável de ambiente (zero mudança em código)
2. **Adicionar novo comando** criando um plugin sem tocar em código existente
3. **Desabilitar uma feature** removendo ou desligando o plugin correspondente
4. **Testar qualquer módulo** isoladamente com mocks injetados
5. **Entender qualquer módulo** lendo seu JSDoc e ~50 linhas de código
6. **MessageHandler** com menos de 150 linhas e responsabilidade única (orquestração)
7. **Zero dependências circulares** entre módulos
8. **80%+ cobertura de testes** no core e adapters
