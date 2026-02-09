import { Logger } from "../utils/Logger.js";

export class BaileysAdapter {
  constructor(sock, message) {
    this.sock = sock;
    this.message = message;
    this.key = message.key;
    this.remoteJid = message.key.remoteJid;
    this.isFromMe = message.key.fromMe;
  }

  // --- Getters de Informação ---

  get raw() {
    return this.message;
  }

  get socket() {
    return this.sock;
  }

  get jid() {
    return this.remoteJid;
  }

  get isGroup() {
    return this.remoteJid.endsWith("@g.us");
  }

  get body() {
    return (
      this.message.message?.conversation ||
      this.message.message?.extendedTextMessage?.text ||
      this.message.message?.imageMessage?.caption ||
      this.message.message?.videoMessage?.caption ||
      null
    );
  }

  get senderName() {
    const pushName = this.message.pushName || "Alguém";
    const match = pushName.match(/^([^\s]+)/);
    return match ? match[1] : pushName;
  }

  // 🔥 LÓGICA BLINDADA COM DEBUG 🔥
  get isRepliedToMe() {
    try {
      const msg = this.message.message;

      // 1. Procura contexto em todos os lugares
      const context =
        msg?.extendedTextMessage?.contextInfo ||
        msg?.imageMessage?.contextInfo ||
        msg?.videoMessage?.contextInfo ||
        msg?.stickerMessage?.contextInfo ||
        msg?.audioMessage?.contextInfo;

      // Se não tem contexto, não é resposta
      if (!context?.participant) return false;

      // 2. Obtém credenciais completas (ID e LID)
      const me = this.sock.authState?.creds?.me;

      if (!me) {
        // Fallback para user.id se authState falhar
        if (this.sock.user?.id) {
          const myId = this.sock.user.id
            .split(":")[0]
            .split("@")[0]
            .replace(/\D/g, "");
          const quotedId = context.participant
            .split(":")[0]
            .split("@")[0]
            .replace(/\D/g, "");
          return myId === quotedId;
        }
        return false;
      }

      // 3. Função de Limpeza
      const clean = (id) => {
        if (!id) return null;
        return id.split(":")[0].split("@")[0].replace(/\D/g, "");
      };

      const quotedClean = clean(context.participant);
      const myIdClean = clean(me.id);
      const myLidClean = clean(me.lid);

      // 4. Comparação Dupla (Telefone OU Dispositivo)
      const isMatch =
        quotedClean === myIdClean || (myLidClean && quotedClean === myLidClean);

      // 🔍 DEBUG: Se estiver em dúvida, descomente a linha abaixo para ver no terminal
      // Logger.info(`DEBUG REPLY: Quoted=${quotedClean} | MeID=${myIdClean} | MeLID=${myLidClean} | Match=${isMatch}`);

      return isMatch;
    } catch (e) {
      Logger.error("Erro ao verificar reply:", e);
      return false;
    }
  }

  get quotedMessage() {
    const msg = this.message.message;
    const context =
      msg?.extendedTextMessage?.contextInfo ||
      msg?.imageMessage?.contextInfo ||
      msg?.videoMessage?.contextInfo ||
      msg?.stickerMessage?.contextInfo;

    return context?.quotedMessage;
  }

  get quotedText() {
    const q = this.quotedMessage;
    if (!q) return null;

    return (
      q.conversation ||
      q.extendedTextMessage?.text ||
      q.imageMessage?.caption ||
      q.videoMessage?.caption ||
      null
    );
  }

  // --- Métodos de Envio ---

  async sendText(text, options = {}) {
    const payload = { text };
    if (options.quoted) {
      const quotedMsg =
        options.quoted instanceof BaileysAdapter
          ? options.quoted.raw
          : options.quoted;
      return await this.sock.sendMessage(this.remoteJid, payload, {
        quoted: quotedMsg,
      });
    }
    return await this.sock.sendMessage(this.remoteJid, payload);
  }

  async reply(text) {
    return await this.sendText(text, { quoted: this.raw });
  }

  async sendPresence(type) {
    return await this.sock.sendPresenceUpdate(type, this.remoteJid);
  }

  async react(emoji) {
    return await this.sock.sendMessage(this.remoteJid, {
      react: { text: emoji, key: this.key },
    });
  }

  // --- Métodos de Usuário/Grupo ---

  async getSenderNumber() {
    try {
      let jid =
        this.message.participant ||
        this.message.key.participant ||
        this.remoteJid;

      if (jid.includes("@lid")) {
        try {
          const [result] = await this.sock.onWhatsApp(jid);
          if (result && result.jid) {
            jid = result.jid;
          }
        } catch (error) {}
      }

      let number = jid.split("@")[0];
      if (number.includes(":")) number = number.split(":")[0];
      return number.replace(/\D/g, "");
    } catch (error) {
      Logger.error("❌ Adapter: Erro ao pegar número", error);
      return null;
    }
  }

  async getMentionedJids() {
    return (
      this.message.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
    );
  }

  // --- Métodos de Mídia/Contexto ---

  get hasVisualContent() {
    return !!(
      this.message.message?.imageMessage ||
      this.message.message?.stickerMessage ||
      this.quotedMessage?.imageMessage ||
      this.quotedMessage?.stickerMessage
    );
  }

  get hasMedia() {
    return !!(
      this.message.message?.imageMessage || this.message.message?.videoMessage
    );
  }

  get hasSticker() {
    return !!this.message.message?.stickerMessage;
  }

  getQuotedAdapter() {
    if (!this.quotedMessage) return null;

    const msg = this.message.message;
    const context =
      msg?.extendedTextMessage?.contextInfo ||
      msg?.imageMessage?.contextInfo ||
      msg?.stickerMessage?.contextInfo;

    const fakeMsg = {
      key: {
        remoteJid: this.remoteJid,
        fromMe: false,
        id: context?.stanzaId,
        participant: context?.participant,
      },
      message: this.quotedMessage,
    };

    return new BaileysAdapter(this.sock, fakeMsg);
  }
}
