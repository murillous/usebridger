<div align="center">

# LumaBot

**Bot de WhatsApp com IA que se passa por uma humana no chat.**

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Baileys](https://img.shields.io/badge/Baileys-7.x-25D366?logo=whatsapp&logoColor=white)](https://github.com/WhiskeySockets/Baileys)
[![Gemini AI](https://img.shields.io/badge/Gemini-2.5%20Flash-4285F4?logo=google&logoColor=white)](https://ai.google.dev/)
[![DeepSeek](https://img.shields.io/badge/DeepSeek-Chat-6B5CFF?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PC9zdmc+&logoColor=white)](https://www.deepseek.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

---

## O que é

LumaBot é um bot de WhatsApp com uma assistente virtual chamada **Luma**. Ela responde mensagens,faz figurinhas, analisa imagens, transcreve áudios, faz buscas na internet e interage espontaneamente em grupos — tudo com personalidade própria, como se fosse uma pessoa real.

---

## O que ela faz

**Conversas com IA**
- Responde quando chamada pelo nome (`luma, ...`) ou em mensagens privadas
- Analisa imagens, stickers e memes enviados no chat
- Transcreve áudios automaticamente
- Busca na internet quando precisa de informações atuais
- Mantém contexto de até 80 mensagens por conversa

**Interações espontâneas em grupos**
- Reage, comenta ou puxa assunto sem ser chamada
- Chance dinâmica baseada na atividade do grupo (4% a 15%)
- Cooldown de 8 minutos por grupo para não ser chata

**Personalidades**
Use `!persona` para mudar o jeito que a Luma se comporta. As opções disponíveis aparecem no menu.

**Mídia**

| Comando | O que faz |
|---------|-----------|
| `!sticker` / `!s` | Imagem, vídeo ou link → sticker |
| `!image` / `!i` | Sticker → imagem PNG |
| `!gif` / `!g` | Sticker animado → GIF |
| `!download <url>` / `!d <url>` | Baixa vídeo do Twitter/X, Instagram ou Youtube|

**Grupo**

| Comando | O que faz |
|---------|-----------|
| `@everyone` / `@todos` | Menciona todos no grupo |
| `!luma clear` / `!lc` | Limpa a memória da conversa |
| `!luma stats` / `!ls` | Estatísticas de uso |
| `!help` / `!menu` | Lista todos os comandos |

**Dashboard Web** (opcional)
Interface para monitorar logs, ligar/desligar/reiniciar o bot e escanear o QR Code pelo browser. Suporta acesso remoto via Cloudflare Tunnel.

---

## Como rodar

### Pré-requisitos

- **Node.js** v18+
- **FFmpeg** no PATH

```bash
# Debian/Ubuntu
sudo apt install ffmpeg -y

# Fedora
sudo dnf install ffmpeg -y

# macOS
brew install ffmpeg

# Windows
choco install ffmpeg
```

### Instalação

```bash
git clone https://github.com/murillous/LumaBot.git
cd LumaBot
npm install
```

### Variáveis de ambiente

Crie um arquivo `.env` na raiz do projeto:

```env
# Provider de IA — 'gemini' (padrão) | 'openai' | 'deepseek'
AI_PROVIDER=gemini

# Gemini (obrigatório se AI_PROVIDER=gemini)
GEMINI_API_KEY=sua_chave_aqui

# OpenAI (obrigatório se AI_PROVIDER=openai)
# OPENAI_API_KEY=sk-...
# AI_MODEL=gpt-4o-mini

# DeepSeek (obrigatório se AI_PROVIDER=deepseek)
# DEEPSEEK_API_KEY=sua_chave_aqui

# Busca na internet — opcional, cai para Google Grounding se ausente
TAVILY_API_KEY=sua_chave_aqui

# Número do dono do bot — opcional
OWNER_NUMBER=5511999999999

# Dashboard — opcional
DASHBOARD_PORT=3000
DASHBOARD_PASSWORD=suasenha
CLOUDFLARE_TUNNEL=true
```

Onde obter as chaves:
- Gemini: [aistudio.google.com](https://aistudio.google.com/app/apikey)
- OpenAI: [platform.openai.com](https://platform.openai.com/api-keys)
- DeepSeek: [platform.deepseek.com](https://platform.deepseek.com/api_keys)
- Tavily: [tavily.com](https://tavily.com)

### Rodando

```bash
# Só o bot
npm start

# Bot + Dashboard web
npm run dashboard
```

Com o dashboard, acesse `http://localhost:3000` e escaneie o QR Code pelo browser. Com `CLOUDFLARE_TUNNEL=true`, uma URL pública é gerada automaticamente.

**Primeiro acesso:**
1. Rode o bot
2. Escaneie o QR Code que aparece no terminal (ou no dashboard)
3. Aguarde a confirmação de conexão

---

## Troubleshooting

**Luma não responde** — verifique se a API Key está correta no `.env`

**Sticker não converte** — confirme FFmpeg com `ffmpeg -version`; responda à mídia antes de usar o comando

**Bot não conecta** — delete a pasta `auth_info/` e escaneie o QR novamente

**Download falha** — o `yt-dlp` é baixado automaticamente na primeira execução; conteúdo privado não pode ser baixado

---

## Documentação técnica

Para arquitetura, design patterns, como adicionar plugins e detalhes internos, veja a pasta [`docs/`](./docs).

---

## Licença

MIT — veja [LICENSE](LICENSE).

---

<div align="center">

Desenvolvido por **Murilo Castelhano**

[⭐ Star](https://github.com/murillous/LumaBot) · [🐛 Bug](https://github.com/murillous/LumaBot/issues) · [💡 Feature](https://github.com/murillous/LumaBot/issues)

</div>
