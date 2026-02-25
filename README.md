<div align="center">

# 🤖 LumaBot - Assistente de WhatsApp com IA & Stickers

**A evolução dos bots de WhatsApp.**

Uma assistente virtual com personalidade dinâmica, visão computacional, ferramentas acionadas por linguagem natural e estúdio profissional de figurinhas.

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Baileys](https://img.shields.io/badge/Baileys-7.x-25D366?logo=whatsapp&logoColor=white)](https://github.com/WhiskeySockets/Baileys)
[![Gemini AI](https://img.shields.io/badge/Gemini-2.5%20Flash-4285F4?logo=google&logoColor=white)](https://ai.google.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

---

## ✨ O Que Há de Novo? (v4.0)

### 🔧 Ferramentas por Linguagem Natural (Tool Calling)
A Luma agora aciona ferramentas automaticamente quando você pede por linguagem natural:
- "Luma, faz uma figurinha disso" → cria o sticker da mídia respondida
- "Luma, transforma em imagem" → converte sticker → PNG
- "Luma, transforma em gif" → converte sticker animado → GIF
- "Luma, marca todo mundo" → menciona todos no grupo
- "Luma, expulsa o Fulano" → remove membro (somente admins)

### 🛡️ Adaptador Inteligente (BaileysAdapter)
Novo sistema que desempacota automaticamente os protocolos do WhatsApp (mensagens temporárias, viewOnce, etc.), garantindo detecção de mídia 100% confiável mesmo em grupos com mensagens temporárias ativadas.

### 🏗️ Refatoração Completa
- Código limpo com comentários em português nas partes importantes
- Remoção do sistema de blacklist (desnecessário com número dedicado)
- `ToolDispatcher` independente para despacho de ferramentas da IA
- Verificação de admin para comandos de remoção de membros

---

## 🧠 Luma: Inteligência Artificial Avançada

A Luma utiliza o modelo **Gemini 2.5 Flash** com visão multimodal, memória de contexto e chamada de ferramentas.

### 🎭 Personalidades Dinâmicas

Cansou da Luma boazinha? **Mude o humor dela!**

| Personalidade | Descrição | Exemplo |
|--------------|-----------|---------|
| 🎭 **Sarcástica** | Ajuda, mas reclama e faz piada | "Ah claro, vou largar tudo pra fazer SEU sticker..." |
| 😤 **Agressiva** | Curta, grossa e sem paciência | "Quer o sticker? Manda a foto. Sem enrolação." |
| 💖 **Amigável** | Fofa, usa muitos emojis | "Oiii! 🥰 Claro que eu faço seu sticker! ✨" |
| 🎓 **Intelectual** | Formal, técnica e correta | "Certamente. Processarei sua solicitação." |
| 🏖️ **Carioca** | Cheia de gírias e marra | "E aí, parça! Bora criar uns adesivo da hora!" |

**Como mudar:**
```
Digite: !persona
→ Menu interativo aparecerá com todas as opções
```

### 🔧 Ferramentas da IA (Tool Calling)

A Luma pode executar ações reais no WhatsApp quando você pede naturalmente:

| Ferramenta | Exemplo de Frase | Restrição |
|-----------|------------------|-----------|
| Criar Figurinha | "Luma, faz figurinha dessa imagem" | — |
| Converter p/ Imagem | "Luma, transforma essa figurinha em foto" | — |
| Converter p/ GIF | "Luma, transforma isso em gif" | — |
| Marcar Todos | "Luma, chama todo mundo" | Apenas em grupos |
| Remover Membro | "Luma, expulsa o João" | Apenas admins |
| Limpar Memória | "Luma, esquece tudo" | — |

### 👁️ Visão Computacional

- **Analisa fotos, memes e figurinhas** com contexto completo
- **Entende o contexto visual** e reage de acordo com a personalidade ativa
- **Lê textos em imagens** (OCR integrado)

**Exemplos de uso:**
```
✅ [Foto de comida] + "luma, tá bom isso?"
✅ [Meme] + "ei luma, explica esse meme"
✅ [Selfie] + "luma, comenta essa foto"
```

### 🧠 Memória de Contexto

- Mantém **até 20 mensagens** por conversa
- Lembra do que foi dito anteriormente
- **Auto-limpeza** após 2 horas de inatividade
- Histórico pode ser limpo com `!luma clear`

---

## 🎨 Estúdio de Mídia Profissional

### 🖼️ Conversões Disponíveis

| Entrada | Saída | Comando | Via Luma (IA) |
|---------|-------|---------|---------------|
| 📷 Imagem | 🎭 Sticker | `!sticker` | "Luma, faz figurinha" |
| 🎥 Vídeo/GIF | 🎬 Sticker Animado | `!sticker` | "Luma, faz figurinha" |
| 🎭 Sticker | 🖼️ PNG | `!image` | "Luma, converte em imagem" |
| 🎬 Sticker Animado | 🎞️ GIF/MP4 | `!gif` | "Luma, converte em gif" |
| 🔗 URL | 🎭 Sticker | `!sticker <url>` | — |

### 🏷️ Metadados Profissionais (Auto-Exif)

Todas as figurinhas incluem automaticamente:
- ✅ Nome do pacote: "LumaBot 🤖"
- ✅ Autor: "Criado por @Luma"
- ✅ Links e emojis personalizados

### ⚙️ Otimizações Automáticas

- **Redimensionamento**: Sempre 512x512 pixels
- **Compressão inteligente**: Mantém < 800 KB
- **Qualidade preservada**: Sharp + FFmpeg otimizados
- **Limpeza automática**: Arquivos temporários removidos

---

## 📦 Instalação

### 1. Pré-requisitos

- **Node.js** v18.0.0 ou superior
- **FFmpeg** instalado e no PATH do sistema
- Conta Google para API do Gemini (gratuita)

### 2. Clonar e Instalar

```bash
git clone https://github.com/murillous/LumaBot.git
cd LumaBot
npm install
```

### 3. Instalar o FFmpeg

**Linux (Debian/Ubuntu):**
```bash
sudo apt update && sudo apt install ffmpeg -y
```

**MacOS:**
```bash
brew install ffmpeg
```

**Windows:**
1. [Download FFmpeg](https://ffmpeg.org/download.html)
2. Extrair e adicionar ao PATH

### 4. Configuração (.env)

Crie um arquivo `.env` na raiz do projeto:

```env
GEMINI_API_KEY=sua_chave_aqui
OWNER_NUMBER=5598988776655
```

**Obter API Key:**
1. Acesse [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Crie uma API Key gratuita
3. Cole no arquivo `.env`

### 5. Descobrir seu número

```
1. Inicie o bot e escaneie o QR Code
2. Envie !meunumero em qualquer conversa
3. Copie o número e configure em OWNER_NUMBER no .env
```

---

## ▶️ Como Usar

### Iniciar o Bot

```bash
# Produção
npm start

# Desenvolvimento (hot-reload)
npm run dev
```

### Primeiros Passos

1. Execute `npm start`
2. **Escaneie o QR Code** com seu WhatsApp
3. Aguarde: **✅ Conectado com sucesso!**
4. Use os comandos ou converse com a Luma

---

## 🎯 Comandos Completos

### 🧠 Assistente Virtual Luma

#### Conversação Natural

Acione a Luma usando qualquer gatilho:
```
• luma, [mensagem]
• ei luma, [mensagem]
• oi luma, [mensagem]
• Responder mensagem da Luma diretamente
• Mensagens privadas (responde automaticamente)
```

#### !persona — Mudar personalidade
Abre menu interativo para trocar o humor da Luma.
- 🎭 Cada chat pode ter personalidade diferente
- 💾 Configuração é salva permanentemente

#### !luma stats — Estatísticas
Exibe métricas globais: stickers criados, mensagens processadas, conversas ativas.

#### !luma clear — Limpar memória
Limpa o histórico de conversa com a Luma no chat atual.

### 🎨 Comandos de Mídia

| Comando | Descrição | Uso |
|---------|-----------|-----|
| `!sticker` / `!s` | Criar figurinha | Envie ou responda mídia |
| `!image` / `!i` | Sticker → Imagem PNG | Envie ou responda sticker |
| `!gif` / `!g` | Sticker → GIF/MP4 | Envie ou responda sticker animado |
| `!sticker <url>` | Figurinha via URL | Cole o link direto |

### 👥 Gerenciamento de Grupos

| Comando | Descrição | Requisito |
|---------|-----------|-----------|
| `@everyone` / `@todos` | Mencionar todos | Apenas em grupos |
| `!meunumero` | Ver seu ID e o do chat | — |
| `!help` / `!menu` | Listar comandos | — |

---

## 🏗️ Arquitetura do Projeto

```
lumabot/
├── data/
│   ├── luma_metrics.sqlite   # 🟢 Público: Estatísticas (Git)
│   └── luma_private.sqlite   # 🔴 Privado: Configs (Ignorado)
├── src/
│   ├── adapters/
│   │   └── BaileysAdapter.js    # Adaptador do Baileys com unwrap
│   ├── config/
│   │   ├── constants.js         # Configurações gerais
│   │   └── lumaConfig.js        # Personalidades e prompts
│   ├── handlers/
│   │   ├── LumaHandler.js       # Pipeline da IA
│   │   ├── MediaProcessor.js    # Processamento de mídia
│   │   ├── MessageHandler.js    # Controlador de mensagens
│   │   └── ToolDispatcher.js    # Despacho de ferramentas da IA
│   ├── managers/
│   │   ├── ConnectionManager.js    # Conexão WhatsApp
│   │   ├── GroupManager.js         # Funções de grupo
│   │   └── PersonalityManager.js   # Personalidades por chat
│   ├── processors/
│   │   ├── ImageProcessor.js    # Sharp - Imagens
│   │   └── VideoConverter.js    # FFmpeg - Vídeos
│   ├── services/
│   │   ├── AIService.js         # Cliente Google Gemini
│   │   └── Database.js          # SQLite dual database
│   └── utils/
│       ├── Exif.js              # Metadados WebP
│       ├── FileSystem.js        # Gerenciamento de arquivos
│       └── Logger.js            # Sistema de logs
├── temp/                        # Arquivos temporários
├── auth_info/                   # Sessão do WhatsApp
├── .env                         # API Keys
├── index.js                     # Entry point
└── package.json
```

### Princípios de Design

- **Clean Architecture**: Separação clara de responsabilidades
- **Adaptador Inteligente**: `BaileysAdapter` com `unwrapMessage` para transparência de protocolos
- **Tool Calling**: `ToolDispatcher` centraliza ações acionadas pela IA
- **Dual Database**: Dados privados separados de métricas públicas

---

## ⚙️ Configuração Avançada

### Personalizar Metadados dos Stickers

Edite `src/config/constants.js`:
```javascript
export const STICKER_METADATA = {
  PACK_NAME: "LumaBot 🤖",
  AUTHOR: "Criado com ❤️ por LumaBot"
};
```

### Criar Novas Personalidades

Edite `src/config/lumaConfig.js`:
```javascript
nova_persona: {
  name: "Nome da Persona",
  description: "Aparece no menu",
  context: `Você é uma IA que...`,
  style: "Estilo de escrita",
  traits: ["use emojis", "seja concisa", "faça piadas"]
}
```

### Ajustar Qualidade das Figurinhas

Em `src/config/constants.js`:
```javascript
export const CONFIG = {
  STICKER_SIZE: 512,       // Dimensões (px)
  STICKER_QUALITY: 90,     // Qualidade Sharp (0-100)
  VIDEO_DURATION: 6,       // Duração vídeos (s)
  GIF_DURATION: 8,         // Duração GIFs (s)
  VIDEO_FPS: 15,           // FPS animações
  MAX_FILE_SIZE: 800,      // Tamanho máximo (KB)
};
```

---

## 🐛 Troubleshooting

### Luma não responde
- [ ] Arquivo `.env` existe com `GEMINI_API_KEY`
- [ ] Mencionou "luma" na mensagem ou está no privado
- [ ] Verifique logs no terminal

### Sticker/Imagem/GIF não converte
- [ ] FFmpeg instalado: `ffmpeg -version`
- [ ] Está respondendo à mídia correta
- [ ] Se usando Luma, verifique se a ferramenta foi acionada nos logs

### Bot não conecta
1. Verificar internet
2. Deletar `auth_info` e reescanear QR
3. Confirmar FFmpeg: `ffmpeg -version`
4. Reiniciar o bot

### "API Key inválida"
1. Verificar `.env` sem espaços/aspas
2. Gerar nova key no [AI Studio](https://aistudio.google.com/app/apikey)
3. Reiniciar o bot após alterar

---

## 🛠 Tecnologias Utilizadas

| Tecnologia | Propósito |
|------------|-----------|
| [Node.js](https://nodejs.org/) v18+ | Runtime JavaScript |
| [Baileys](https://github.com/WhiskeySockets/Baileys) v7.x | WhatsApp Web API |
| [Google Gemini AI](https://ai.google.dev/) 2.5 Flash | IA com visão multimodal + tool calling |
| [Sharp](https://sharp.pixelplumbing.com/) | Processamento de imagens |
| [FFmpeg](https://ffmpeg.org/) | Processamento de vídeos |
| [Better-SQLite3](https://www.npmjs.com/package/better-sqlite3) | Banco de dados local |
| [dotenv](https://github.com/motdotla/dotenv) | Variáveis de ambiente |

---

## 🤝 Contribuindo

Contribuições são muito bem-vindas!

### Como Contribuir

1. **Fork** o projeto
2. Crie uma **branch**: `git checkout -b feature/MinhaFeature`
3. **Commit**: `git commit -m 'Add: MinhaFeature incrível'`
4. **Push**: `git push origin feature/MinhaFeature`
5. Abra um **Pull Request**

### Diretrizes

- ✅ Siga os princípios de Clean Code
- ✅ Comentários em português, apenas nas partes importantes
- ✅ Teste suas mudanças antes de submeter
- ✅ Documente novas personalidades

---

## 📝 Licença

Este projeto é open source e está disponível sob a [Licença MIT](LICENSE).

---

## 🎓 Créditos

**Desenvolvido por Murilo Castelhano**

Desenvolvido com [Baileys](https://github.com/WhiskeySockets/Baileys), [Sharp](https://sharp.pixelplumbing.com/), [FFmpeg](https://ffmpeg.org/) e [Google Gemini AI](https://ai.google.dev/).

### Funcionalidades Principais

- ✅ Assistente virtual com IA, visão e tool calling
- ✅ Sistema de personalidades dinâmicas
- ✅ Ferramentas acionadas por linguagem natural
- ✅ Metadados profissionais (Exif)
- ✅ Adaptador inteligente com unwrap de protocolos
- ✅ Dual database system
- ✅ Conversão completa de mídia
- ✅ Verificação de admin para remoção de membros
- ✅ Reconexão automática inteligente
- ✅ Arquitetura limpa e modular

---

<div align="center">

**Feito com ❤️ para meus amigos**

[⭐ Star no GitHub](https://github.com/murillous/LumaBot) • [🐛 Report Bug](https://github.com/murillous/LumaBot/issues) • [💡 Request Feature](https://github.com/murillous/LumaBot/issues)

</div>
