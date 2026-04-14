<div align="center">

# 🤖 LumaBot

**Assistente de WhatsApp com IA, personalidades dinâmicas e dashboard de controle.**

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Baileys](https://img.shields.io/badge/Baileys-7.x-25D366?logo=whatsapp&logoColor=white)](https://github.com/WhiskeySockets/Baileys)
[![Gemini AI](https://img.shields.io/badge/Gemini-2.5%20Flash-4285F4?logo=google&logoColor=white)](https://ai.google.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

---

## Visão Geral

LumaBot é um bot de WhatsApp construído sobre o Baileys com uma assistente virtual chamada **Luma** — uma IA com personalidade que se passa por uma pessoa humana no chat. Inclui visão computacional, tool calling, transcrição de áudio, interações espontâneas em grupos, estúdio de mídia completo e um **dashboard web** para monitoramento e controle remoto.

---

## Funcionalidades

### 🧠 Luma — Assistente Virtual

- **Gemini 2.5 Flash** com fallback automático entre modelos
- **Personalidades dinâmicas** por chat (Pensadora, Pistola, Good Vibes, Sênior)
- **Visão computacional** — analisa imagens, stickers e memes
- **Tool calling** — executa ações no WhatsApp por linguagem natural
- **Transcrição de áudio** — transcreve áudios via Gemini multimodal
- **Memória de contexto** — até 80 mensagens por conversa, auto-limpeza após 2h
- **Buffer de grupo** — captura as últimas 15 mensagens do grupo e injeta no prompt
- **Busca na internet** — Tavily API com fallback para Google Search Grounding

### 🎲 Interações Espontâneas

A Luma "ganha vida" em grupos sem ser chamada:

| Tipo | Chance | Descrição |
|------|--------|-----------|
| Reagir | 35% | Reage com emoji à mensagem |
| Responder | 35% | Comenta a mensagem sem ter sido chamada |
| Puxar assunto | 30% | Inicia um assunto aleatório |

- Chance dinâmica: **4%** (grupo quieto) → **10%** (grupo ativo) → **15%** (imagem/sticker)
- Cooldown de **8 minutos** por grupo

### 🎨 Estúdio de Mídia

| Entrada | Saída | Comando |
|---------|-------|---------|
| Imagem | Sticker | `!sticker` |
| Vídeo / GIF | Sticker Animado | `!sticker` |
| Sticker | PNG | `!image` |
| Sticker Animado | GIF / MP4 | `!gif` |
| URL | Sticker | `!sticker <url>` |

### 📥 Download de Vídeos

- `!download <url>` ou `!d <url>`
- Suporte a Twitter/X e Instagram (Reels, posts, stories)
- Limite de 720p, re-encoding automático para **H.264 + faststart** (compatível com iOS)
- Binário `yt-dlp` standalone com auto-download por SO

### 🖥️ Dashboard Web

- Interface terminal com monitoramento em tempo real via **WebSocket**
- Controle do bot: ligar, desligar, reiniciar
- Stream de logs com filtro por nível (INFO / WARN / ERROR / OK) e busca por texto
- QR Code renderizado automaticamente no browser quando necessário
- Acesso remoto via **Cloudflare Tunnel** (URL pública gerada automaticamente)
- Proteção por senha via variável de ambiente

---

## Comandos

### Assistente Luma

| Gatilho | Descrição |
|---------|-----------|
| `luma, [mensagem]` | Aciona a Luma |
| `ei luma`, `oi luma` | Variações de trigger |
| Responder mensagem da Luma | Continua a conversa |
| Mensagem privada | Responde automaticamente |

### Mídia

| Comando | Descrição |
|---------|-----------|
| `!sticker` / `!s` | Imagem, vídeo ou link → sticker |
| `!image` / `!i` | Sticker → imagem PNG |
| `!gif` / `!g` | Sticker animado → GIF |
| `!download` / `!d <url>` | Baixa vídeo de rede social |

### Bot

| Comando | Descrição |
|---------|-----------|
| `!persona` | Abre menu de personalidades |
| `!luma stats` / `!ls` | Estatísticas globais |
| `!luma clear` / `!lc` | Limpa memória da conversa |
| `@everyone` / `@todos` | Menciona todos no grupo |
| `!meunumero` | Exibe seu ID e o do chat |
| `!help` / `!menu` | Lista de comandos |

---

## Instalação

### Pré-requisitos

- **Node.js** v18+
- **FFmpeg** instalado e no PATH

```bash
# Linux (Debian/Ubuntu)
sudo apt install ffmpeg -y

# Fedora
sudo dnf install ffmpeg -y

# macOS
brew install ffmpeg
```

### Setup

```bash
git clone https://github.com/murillous/LumaBot.git
cd LumaBot
npm install
```

### Configuração (`.env`)

```env
# Obrigatório
GEMINI_API_KEY=sua_chave_aqui

# Opcional
OWNER_NUMBER=5598988776655
TAVILY_API_KEY=sua_chave_aqui

# Dashboard
DASHBOARD_PORT=3000
DASHBOARD_PASSWORD=suasenha

# Cloudflare Tunnel (URL pública)
CLOUDFLARE_TUNNEL=true
```

**Obter API Keys:**
- Gemini: [aistudio.google.com](https://aistudio.google.com/app/apikey)
- Tavily: [tavily.com](https://tavily.com)

---

## Uso

### Apenas o Bot

```bash
npm start          # produção
npm run dev        # desenvolvimento (hot-reload)
```

### Bot + Dashboard

```bash
npm run dashboard          # produção
npm run dashboard:dev      # desenvolvimento (hot-reload)
```

O dashboard sobe em `http://localhost:3000` e inicia o bot automaticamente. Com `CLOUDFLARE_TUNNEL=true`, uma URL pública é gerada e exibida no painel.

> **Cloudflared:** instale em [developers.cloudflare.com/cloudflared](https://developers.cloudflare.com/cloudflared/install) para usar o tunnel.

### Primeiros Passos

1. Suba o bot ou o dashboard
2. Escaneie o QR Code (terminal ou modal do dashboard)
3. Aguarde: **✅ Conectado com sucesso!**

---

## Arquitetura

```
LumaBot/
├── index.js                      # Entry point do bot
├── dashboard/
│   └── server.js                 # Servidor Express + WebSocket + gerenciamento do bot
├── src/
│   ├── adapters/
│   │   └── BaileysAdapter.js     # Unwrap de protocolos do WhatsApp
│   ├── config/
│   │   ├── constants.js          # Comandos, mensagens e configurações
│   │   └── lumaConfig.js         # Personalidades, prompts e tools da IA
│   ├── handlers/
│   │   ├── LumaHandler.js        # Pipeline da IA: histórico, prompt, resposta
│   │   ├── MediaProcessor.js     # Download e conversão de mídia
│   │   ├── MessageHandler.js     # Controlador central de mensagens
│   │   ├── SpontaneousHandler.js # Interações espontâneas em grupos
│   │   └── ToolDispatcher.js     # Despacho de tool calls da IA
│   ├── managers/
│   │   ├── ConnectionManager.js  # Conexão WhatsApp e reconexão automática
│   │   ├── GroupManager.js       # Funções de grupo (menção, remoção)
│   │   └── PersonalityManager.js # Personalidades por chat (persistidas)
│   ├── processors/
│   │   ├── ImageProcessor.js     # Sharp: resize, compressão, sticker
│   │   └── VideoConverter.js     # FFmpeg: remux H.264 + faststart para iOS
│   ├── public/
│   │   ├── dashboard.html        # Interface do dashboard
│   │   ├── dashboard.js          # Cliente WebSocket + lógica do dashboard
│   │   ├── login.html            # Página de autenticação
│   │   └── styles.css            # Estética terminal
│   ├── services/
│   │   ├── AIService.js          # Cliente Gemini com fallback entre modelos
│   │   ├── AudioTranscriber.js   # Transcrição de áudio via Gemini multimodal
│   │   ├── Database.js           # SQLite dual (métricas públicas + dados privados)
│   │   ├── VideoDownloader.js    # Download via yt-dlp
│   │   └── WebSearchService.js   # Tavily API + Google Search Grounding
│   └── utils/
│       ├── Exif.js               # Metadados WebP nos stickers
│       ├── FileSystem.js         # Helpers de sistema de arquivos
│       └── Logger.js             # Sistema de logs
├── data/
│   ├── luma_metrics.sqlite       # Métricas públicas (versionado)
│   └── luma_private.sqlite       # Configurações privadas (ignorado)
├── bin/
│   └── yt-dlp                    # Binário standalone (auto-download)
└── temp/                         # Arquivos temporários
```

### Comunicação Dashboard ↔ Bot

O dashboard gerencia o bot como um **processo filho** (`child_process.spawn`). A comunicação acontece via stdout com prefixos reservados:

| Sinal | Direção | Descrição |
|-------|---------|-----------|
| `[LUMA_QR]:rawdata` | bot → dashboard | QR Code para renderizar no browser |
| `[LUMA_STATUS]:connected` | bot → dashboard | WhatsApp conectado |
| `[LUMA_STATUS]:connecting` | bot → dashboard | Tentando conectar |
| `[LUMA_STATUS]:disconnected` | bot → dashboard | Desconectado |

O dashboard transmite todos os eventos para o browser via **WebSocket**.

---

## Tecnologias

| Tecnologia | Versão | Uso |
|------------|--------|-----|
| [Node.js](https://nodejs.org/) | 18+ | Runtime |
| [Baileys](https://github.com/WhiskeySockets/Baileys) | 7.x | WhatsApp Web API |
| [Google Gemini AI](https://ai.google.dev/) | 2.5 Flash | IA multimodal + tool calling |
| [Express](https://expressjs.com/) | 5.x | Servidor HTTP do dashboard |
| [ws](https://github.com/websockets/ws) | 8.x | WebSocket (tempo real) |
| [Sharp](https://sharp.pixelplumbing.com/) | 0.32 | Processamento de imagens |
| [FFmpeg](https://ffmpeg.org/) | — | Processamento de vídeos |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | 12.x | Banco de dados local |
| [qrcode](https://github.com/soldair/node-qrcode) | 1.x | Renderização do QR no dashboard |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | latest | Download de vídeos sociais |
| [cloudflared](https://developers.cloudflare.com/cloudflared/) | — | Tunnel para URL pública |

---

## Configurações Avançadas

### Personalizar Stickers

`src/config/constants.js`:
```js
export const STICKER_METADATA = {
  PACK_NAME: "LumaBot 🤖",
  AUTHOR: "Criado com ❤️ por LumaBot",
};
```

### Criar Nova Personalidade

`src/config/lumaConfig.js`:
```js
PERSONALITIES: {
  minha_persona: {
    name: "Nome da Persona",
    description: "Aparece no menu",
    context: "Você é uma IA que...",
    style: "Estilo de escrita",
    traits: ["traço 1", "traço 2"],
  }
}
```

### Ajustar Interações Espontâneas

`src/config/lumaConfig.js` → `SPONTANEOUS`:
```js
chance: 0.04,           // 4% grupo quieto
imageChance: 0.15,      // 15% quando tem imagem
cooldownMs: 8 * 60000,  // 8 minutos entre interações
```

---

## Troubleshooting

**Luma não responde**
- Verifique se `GEMINI_API_KEY` está no `.env`
- Mensagem precisa conter "luma" ou ser no privado

**Sticker / GIF não converte**
- Confirme FFmpeg instalado: `ffmpeg -version`
- Responda à mídia antes de usar o comando

**Bot não conecta**
- Delete a pasta `auth_info` e escaneie o QR novamente
- Verifique conexão com a internet

**Dashboard inacessível**
- Confirme que `npm run dashboard` está rodando
- Verifique a porta em `DASHBOARD_PORT` (padrão: 3000)

**Download falha**
- `yt-dlp` é baixado automaticamente na primeira execução
- Conteúdo privado não pode ser baixado

---

## Licença

MIT — veja [LICENSE](LICENSE).

---

<div align="center">

Desenvolvido por **Murilo Castelhano**

[⭐ Star](https://github.com/murillous/LumaBot) · [🐛 Bug](https://github.com/murillous/LumaBot/issues) · [💡 Feature](https://github.com/murillous/LumaBot/issues)

</div>
