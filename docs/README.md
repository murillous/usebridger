# Documentação Técnica — LumaBot

Base de conhecimento do LumaBot v6.1. Implementa **Arquitetura Hexagonal (Ports & Adapters)** com **Plugin System** e **Injeção de Dependências**.

> Antes de qualquer coisa, leia o [`CLAUDE.md`](../CLAUDE.md) na raiz do projeto — ele contém as convenções obrigatórias, a arquitetura em mapa e o que você não deve fazer.

---

## Trilha de Leitura

| # | Doc | O que você aprende |
|---|-----|--------------------|
| 1 | [Arquitetura & Fluxos](./01-Arquitetura.md) | Pipeline de mensagens, camadas (core/adapters/plugins/infra), design patterns, fluxos detalhados por cenário |
| 2 | [Núcleo de IA](./02-nucleo-ia.md) | Como a Luma monta prompts, gerencia memória e usa tool calling |
| 3 | [Motor de Mídia](./03-motor-midia.md) | Processamento de imagens (Sharp), stickers, vídeos (FFmpeg) e downloads |
| 4 | [Banco de Dados](./04-banco-dados.md) | Estratégia híbrida SQLite — métricas públicas vs. dados privados |
| 5 | [Conexão WhatsApp](./05-conexao-wa.md) | Baileys, autenticação via QR, política de reconexão automática |

---

## Stack Tecnológica

| Tecnologia | Uso |
|------------|-----|
| **Node.js 18+** | Runtime com ESM nativo |
| **Baileys 7.x** | WhatsApp Web API (engenharia reversa do protocolo) |
| **Google Gemini** | IA multimodal + tool calling (provider padrão) |
| **OpenAI / DeepSeek** | Providers alternativos — troca via `AI_PROVIDER` no `.env` |
| **Sharp** | Processamento de imagem 5× mais rápido que Canvas/Jimp |
| **FFmpeg** | Processamento de vídeo — stickers animados, remux H.264 |
| **yt-dlp** | Download de vídeos de redes sociais |
| **better-sqlite3** | SQLite síncrono — sem latência de rede, ideal para dados locais |
| **Vitest** | Suite de testes unitários (490+ testes) |
| **pino** | Logger estruturado de alta performance |

---

## Estrutura de Diretórios

```
lumabot/
├── CLAUDE.md               ← leia antes de qualquer coisa
├── index.js                ← entry point do bot
├── dashboard/server.js     ← Express + WebSocket + processo filho do bot
├── src/
│   ├── core/               ← domínio puro (sem dependências externas)
│   ├── adapters/           ← implementações concretas dos ports
│   ├── plugins/            ← features como módulos plug-n-play
│   ├── infra/              ← wiring (DI container, bootstrap, socket factory)
│   ├── handlers/           ← pipeline de mensagens
│   ├── managers/           ← estado persistente (conexão, personalidade)
│   ├── services/           ← clientes de APIs externas
│   ├── processors/         ← workers computacionais puros (imagem, vídeo)
│   ├── config/             ← env, constants, lumaConfig
│   └── utils/              ← helpers sem side effects
├── tests/unit/             ← espelha src/, Vitest
├── docs/                   ← esta documentação
└── data/                   ← SQLite (luma_metrics.sqlite versionado)
```

---

## Quick Reference

### Onde fica cada coisa

| Quero mexer em... | Arquivo |
|-------------------|---------|
| Personalidades e prompts | `src/config/lumaConfig.js` |
| Comandos e mensagens de UI | `src/config/constants.js` |
| Variáveis de ambiente | `src/config/env.js` |
| Adicionar um comando novo | Crie um plugin em `src/plugins/` e registre em `MessageHandler.js` |
| Trocar o provider de IA | Variável `AI_PROVIDER` no `.env` |
| Lógica de reconexão | `src/infra/ReconnectionPolicy.js` |
| Como o prompt é montado | `src/core/services/PromptBuilder.js` |
| Histórico de conversa | `src/core/services/ConversationHistory.js` |

### Comandos

```bash
npm start              # bot em produção
npm run dev            # bot com hot-reload
npm run dashboard      # bot + dashboard web
npm test               # suite completa de testes
npm run test:coverage  # cobertura de testes
```
