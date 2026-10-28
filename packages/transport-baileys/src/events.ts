// Mapeamento de eventos (M2-1.6): o que o Baileys emite além das mensagens novas → eventos do
// barramento (plano §6.4). Reação, edição e apagamento chegam ao Baileys como mensagens de
// controle, que ele já converte em `messages.reaction` e `messages.update`; grupos chegam em
// `groups.upsert`, `groups.update` e `group-participants.update`.

import type { Chat, Contact, Logger, Message } from '@usebridger/core';
import type { AuthStateStore, TransportEvents } from '@usebridger/core/adapter';
import {
  type Contact as BaileysContact,
  type BaileysEventMap,
  type GroupMetadata as BaileysGroupMetadata,
  isJidGroup,
  isJidStatusBroadcast,
  isLidUser,
  jidDecode,
  jidNormalizedUser,
  type WAMessageUpdate,
} from 'baileys';
import * as LOG from './log-events.ts';
import {
  authorJid,
  authorOf,
  type NormalizeEnv,
  resolveContact,
  toEditedMessage,
} from './normalize.ts';

type Env = Pick<NormalizeEnv, 'selfIds' | 'pnForLid'>;

/** Tipo das entradas no auth state da sessão; o id é o JID normalizado e o valor, o nome. */
const NAME_KEY = 'bridger-contact-name';
/**
 * Espera antes de gravar os nomes novos. Uma sincronização inicial observa milhares de contatos
 * em sequência: com o debounce vira um punhado de gravações em vez de uma por contato.
 */
const FLUSH_DELAY_MS = 2000;

export interface ContactBookOptions {
  /** Onde os nomes persistem; sem ele o livro vive só em memória. */
  readonly store?: Pick<AuthStateStore, 'getKeys' | 'setKeys'>;
  readonly log?: Pick<Logger, 'event'>;
}

/**
 * Nome e telefone já vistos de cada contato. Decide quando sai o `contact.updated` e dá nome a
 * quem aparece sem `pushName` (reação, edição, apagamento, grupo). Vive enquanto o transport
 * vive; os nomes também persistem no auth state da sessão, mas o `contact.updated` não: depois de
 * reiniciar o processo, cada contato conta de novo como visto pela primeira vez.
 *
 * Persistência sem storage no caminho quente: a leitura é lazy e com cache negativo,
 * só quando a memória não sabe o nome; a escrita é em lote, com debounce.
 */
export class ContactBook {
  readonly #known = new Map<
    string,
    { readonly name: string | null; readonly phone: string | null }
  >();
  /**
   * Nome por id fora de `#known`: o do id par (LID ↔ telefone) de quem foi observado e o que veio
   * do storage. Fica fora para o `contact.updated` seguir por id, sem evento duplicado por causa
   * do apelido nem por um nome que só foi lido.
   */
  readonly #aliasNames = new Map<string, string>();
  readonly #store: ContactBookOptions['store'];
  readonly #log: ContactBookOptions['log'];
  /** O que o storage tem (ou vai ter) por id: evita sujar de novo o mesmo nome. */
  readonly #saved = new Map<string, string>();
  /** Nomes a gravar no próximo flush. */
  readonly #dirty = new Map<string, string>();
  /** Ids já consultados no storage, com ou sem resultado (cache negativo). */
  readonly #asked = new Set<string>();
  /** Leituras em andamento por id: leitores concorrentes dividem a mesma consulta. */
  readonly #reading = new Map<string, Promise<void>>();
  #timer: NodeJS.Timeout | undefined;
  /** Gravações em fila, uma de cada vez. */
  #writing: Promise<void> = Promise.resolve();
  /** Sobe no `reset()`: leitura e gravação de antes dele não valem mais. */
  #epoch = 0;
  /**
   * Ids cujo nome em `#known` veio só da agenda do aparelho do bot. Valem por último: o nome que a
   * pessoa escolheu (pushName), mesmo o lido do storage, vem antes. Por isso também não persistem.
   */
  readonly #bookOnly = new Set<string>();

  constructor(options: ContactBookOptions = {}) {
    this.#store = options.store;
    this.#log = options.log;
  }

  /**
   * Registra um remetente. Devolve o `contact.updated` quando há o que contar: na primeira vez
   * que o contato aparece ou quando o nome ou o telefone mudou. Campo desconhecido
   * (`null`) não apaga o que já se sabia.
   */
  observe(
    contact: Contact,
    alias?: string,
    fromBook = false,
  ): TransportEvents['contact.updated'] | null {
    const known = this.#known.get(contact.id);
    const name = contact.name ?? known?.name ?? null;
    const phone = contact.phone ?? known?.phone ?? null;
    this.#known.set(contact.id, { name, phone });
    if (name !== null && fromBook) {
      this.#bookOnly.add(contact.id);
    } else if (name !== null) {
      this.#bookOnly.delete(contact.id);
      this.#remember(contact.id, name);
      // O mesmo contato aparece ora por LID, ora por telefone (ADR 0042): o nome vale nos dois.
      const peer = alias ?? (isLidUser(contact.id) && phone ? `${phone}@s.whatsapp.net` : null);
      if (peer) {
        const peerId = jidNormalizedUser(peer) || peer;
        this.#aliasNames.set(peerId, name);
        this.#remember(peerId, name);
      }
    }
    const update: { id: string; name?: string; phone?: string } = { id: contact.id };
    if (name !== null && name !== known?.name) update.name = name;
    if (phone !== null && phone !== known?.phone) update.phone = phone;
    return update.name === undefined && update.phone === undefined ? null : update;
  }

  nameOf(id: string): string | null {
    return this.#trustedName(id) ?? this.#bookName(id);
  }

  /** Nome que a pessoa escolheu: o observado, o do apelido ou o lido do storage. */
  #trustedName(id: string): string | null {
    const known = this.#bookOnly.has(id) ? null : (this.#known.get(id)?.name ?? null);
    return known ?? this.#aliasNames.get(id) ?? null;
  }

  #bookName(id: string): string | null {
    return this.#bookOnly.has(id) ? (this.#known.get(id)?.name ?? null) : null;
  }

  /**
   * Como `nameOf`, mas completa pelo que a memória não sabe: para um LID tenta o telefone par da
   * sessão (o nome pode ter sido aprendido pelo telefone) e, por fim, o storage, uma vez por id.
   * O inverso (telefone → LID) não tem consulta; vale o apelido registrado quando o LID foi
   * observado com o telefone.
   */
  async nameFor(id: string, env: Pick<NormalizeEnv, 'pnForLid'>): Promise<string | null> {
    const direct = this.#trustedName(id);
    if (direct !== null) return direct;
    let peerId: string | null = null;
    if (isLidUser(id)) {
      const pn = await env.pnForLid(id);
      if (pn) {
        peerId = jidNormalizedUser(pn) || pn;
        const viaPeer = this.#trustedName(peerId);
        if (viaPeer !== null) return viaPeer;
      }
    }
    await this.#load(peerId === null ? [id] : [id, peerId]);
    // A agenda só depois do storage: depois de um restart, o pushName gravado vence.
    return (
      this.#trustedName(id) ??
      (peerId === null ? null : this.#trustedName(peerId)) ??
      this.#bookName(id) ??
      (peerId === null ? null : this.#bookName(peerId))
    );
  }

  /** O contato com o nome já visto, quando o evento não trouxe nenhum (só memória). */
  named(contact: Contact): Contact {
    return contact.name === null ? { ...contact, name: this.nameOf(contact.id) } : contact;
  }

  /** Como `named`, e aproveita a leitura do storage: para reação, voto, apagamento e grupo. */
  async withName(contact: Contact, env: Pick<NormalizeEnv, 'pnForLid'>): Promise<Contact> {
    return contact.name === null
      ? { ...contact, name: await this.nameFor(contact.id, env) }
      : contact;
  }

  /**
   * Grava já o que está pendente e espera o resultado. Nunca rejeita: falha vira `warn` e o lote
   * volta para a próxima tentativa.
   */
  flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#writing = this.#writing.then(() => this.#write());
    return this.#writing;
  }

  /**
   * Esquece tudo, da memória e do lote pendente. O transport chama quando a sessão é encerrada
   * no aparelho: o kernel apaga o auth state em seguida, e um flush atrasado ou uma leitura em
   * andamento não pode trazer de volta nomes de quem não está mais pareado.
   */
  reset(): void {
    this.#epoch++;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#known.clear();
    this.#aliasNames.clear();
    this.#saved.clear();
    this.#dirty.clear();
    this.#asked.clear();
    this.#reading.clear();
    this.#bookOnly.clear();
  }

  #remember(id: string, name: string): void {
    // Observado, o id deixa de ser "consultado sem resultado".
    this.#asked.delete(id);
    if (this.#store === undefined || this.#saved.get(id) === name) return;
    this.#saved.set(id, name);
    this.#dirty.set(id, name);
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, FLUSH_DELAY_MS);
    // Não segura o processo vivo: o `disconnect()` grava o que sobrar.
    this.#timer.unref();
  }

  async #write(): Promise<void> {
    const store = this.#store;
    if (store === undefined || this.#dirty.size === 0) return;
    const epoch = this.#epoch;
    const batch = new Map(this.#dirty);
    this.#dirty.clear();
    try {
      await store.setKeys({ [NAME_KEY]: Object.fromEntries(batch) });
    } catch (error) {
      this.#log?.event(LOG.contactNamesSaveFailed, {
        err: error,
        count: batch.size,
      });
      if (epoch !== this.#epoch) return;
      // Um nome mais novo que entrou nesse meio-tempo vale mais que o do lote que falhou.
      for (const [id, name] of batch) if (!this.#dirty.has(id)) this.#dirty.set(id, name);
    }
  }

  /** Lê do storage os ids ainda não consultados, numa única chamada. */
  async #load(ids: readonly string[]): Promise<void> {
    if (this.#store === undefined) return;
    const waits: Promise<void>[] = [];
    const fresh: string[] = [];
    for (const id of ids) {
      if (this.#asked.has(id)) continue;
      const inFlight = this.#reading.get(id);
      if (inFlight) waits.push(inFlight);
      else fresh.push(id);
    }
    if (fresh.length > 0) {
      const read = this.#read(this.#store, fresh);
      for (const id of fresh) this.#reading.set(id, read);
      waits.push(read);
    }
    await Promise.all(waits);
  }

  async #read(store: NonNullable<ContactBookOptions['store']>, ids: string[]): Promise<void> {
    const epoch = this.#epoch;
    try {
      const found = await store.getKeys(NAME_KEY, ids);
      if (epoch !== this.#epoch) return;
      for (const id of ids) {
        const name = found[id];
        // O que foi observado nesse meio-tempo é mais novo que o que estava gravado.
        if (typeof name === 'string' && this.#trustedName(id) === null) {
          this.#aliasNames.set(id, name);
          if (!this.#saved.has(id)) this.#saved.set(id, name);
        }
        this.#asked.add(id);
      }
    } catch (error) {
      // Sem marcar como consultado: a próxima menção deste id tenta de novo.
      this.#log?.event(LOG.contactNamesReadFailed, {
        err: error,
      });
    } finally {
      if (epoch === this.#epoch) for (const id of ids) this.#reading.delete(id);
    }
  }
}

/**
 * Aprende nomes dos contatos que o Baileys sincroniza (`contacts.upsert`, `contacts.update`,
 * `messaging-history.set`). Prioridade: `notify` (o pushName que a pessoa escolheu, o mesmo que
 * vem nas mensagens), depois `verifiedName` (conta comercial). O `name` é o nome salvo na agenda
 * do aparelho do bot: só entra quando não há nome nenhum, para não trocar o pushName já visto
 * por um apelido privado. Contato sem nome nenhum não gera evento (a sincronização traz milhares
 * e o telefone sozinho não vale um `contact.updated`).
 */
export function learnContacts(
  list: readonly Partial<BaileysContact>[],
  contacts: ContactBook,
): TransportEvents['contact.updated'][] {
  const updates: TransportEvents['contact.updated'][] = [];
  for (const c of list) {
    if (!c.id) continue;
    const id = jidNormalizedUser(c.id) || c.id;
    // `||` e não `??`: o WhatsApp manda `notify` vazio para quem não definiu nome.
    const chosen = c.notify || c.verifiedName || null;
    const name = chosen ?? (contacts.nameOf(id) === null ? c.name || null : null);
    if (name === null) continue;
    const other = isLidUser(id) ? c.phoneNumber : c.lid;
    const pn = isLidUser(id) ? c.phoneNumber : id;
    const phone = pn ? (jidDecode(pn)?.user ?? null) : null;
    const update = contacts.observe({ id, name, phone }, other, chosen === null);
    if (update !== null) updates.push(update);
  }
  return updates;
}

/** O `Chat` de um JID; os eventos de grupo também o usam. */
export function chatOf(id: string): Chat {
  return { id, isGroup: isJidGroup(id) === true };
}

/**
 * `reaction` a partir do `messages.reaction`: `key` é a mensagem reagida e `reaction.key` a
 * mensagem de reação, que diz quem reagiu. Texto vazio é reação removida.
 */
export async function toReaction(
  { key, reaction }: BaileysEventMap['messages.reaction'][number],
  env: Env,
  contacts: ContactBook,
): Promise<TransportEvents['reaction'] | null> {
  const from = reaction.key;
  const chatId = from?.remoteJid ?? key.remoteJid;
  if (!from || !chatId || !key.id || isJidStatusBroadcast(chatId)) return null;
  return {
    chat: chatOf(chatId),
    messageId: key.id,
    sender: await contacts.withName(await authorOf(from, chatId, env, null), env),
    emoji: reaction.text || null,
    fromMe: from.fromMe === true,
  };
}

/**
 * `message.edited` a partir do `messages.update` de edição. A chave é a da original com o autor
 * da edição, e o conteúdo novo vem em `editedMessage`.
 */
export async function toEdited(
  { key, update }: WAMessageUpdate,
  env: NormalizeEnv,
  contacts: ContactBook,
): Promise<Message | null> {
  const content = update.message?.editedMessage?.message;
  const chatId = key.remoteJid;
  if (!content || !chatId || isJidStatusBroadcast(chatId)) return null;
  return toEditedMessage(
    {
      key,
      message: content,
      // Sem o horário da edição, vale o da chegada.
      messageTimestamp: update.messageTimestamp ?? Math.floor(Date.now() / 1000),
      pushName: await contacts.nameFor(jidNormalizedUser(authorJid(key, chatId, env.selfIds)), env),
    },
    env,
    (id) => contacts.nameFor(id, env),
  );
}

/**
 * `message.deleted` a partir do `messages.update` de apagamento (`REVOKE`). `key` é a apagada;
 * `update.key` é a mensagem que apagou, que diz quem apagou (o autor ou um admin do grupo).
 */
export async function toDeleted(
  { key, update }: WAMessageUpdate,
  env: Env,
  contacts: ContactBook,
): Promise<TransportEvents['message.deleted'] | null> {
  const chatId = key.remoteJid;
  if (!chatId || !key.id || isJidStatusBroadcast(chatId)) return null;
  const by = update.key;
  return {
    chat: chatOf(chatId),
    messageId: key.id,
    deletedBy: by ? await contacts.withName(await authorOf(by, chatId, env, null), env) : null,
    fromMe: (by ?? key).fromMe === true,
  };
}

type ParticipantsUpdate = BaileysEventMap['group-participants.update'];
type Participant = ParticipantsUpdate['participants'][number];

/** O que um `group-participants.update` vira no barramento. */
export interface ParticipantEvents {
  /** A própria sessão entrou ou saiu do grupo. */
  readonly self: 'group.joined' | 'group.left' | null;
  /** Os demais participantes; `null` se não sobrou nenhum. */
  readonly others: TransportEvents['group.participants'] | null;
}

/**
 * Converte a alteração de participantes. Entrada e saída da própria sessão viram
 * `group.joined`/`group.left` e saem da lista; promovida ou rebaixada, ela segue em
 * `group.participants`. Troca de número (`modify`) não tem evento no core.
 */
export async function toParticipantEvents(
  { id, author, authorPn, participants, action }: ParticipantsUpdate,
  env: Env,
  contacts: ContactBook,
): Promise<ParticipantEvents> {
  if (action === 'modify') return { self: null, others: null };
  const isSelf = (p: Participant): boolean =>
    [p.id, p.phoneNumber, p.lid].some((jid) => jid && env.selfIds.includes(jidNormalizedUser(jid)));
  const selfIn = participants.some(isSelf);
  const self = !selfIn
    ? null
    : action === 'add'
      ? 'group.joined'
      : action === 'remove'
        ? 'group.left'
        : null;
  const rest = self === null ? participants : participants.filter((p) => !isSelf(p));
  if (rest.length === 0) return { self, others: null };
  const contact = async (jid: string, alt: string | undefined, name: string | null) =>
    contacts.withName(await resolveContact(env, jid, alt, name), env);
  return {
    self,
    others: {
      chat: chatOf(id),
      action,
      participants: await Promise.all(
        rest.map((p) => contact(p.id, p.phoneNumber, p.notify ?? p.name ?? null)),
      ),
      actor: author ? await contact(author, authorPn, null) : null,
    },
  };
}

/**
 * `group.updated` com só os campos que mudaram. O Baileys também emite `groups.update` com os
 * metadados completos de cada grupo ao sincronizar (`groupFetchAllParticipating`); esse traz
 * `participants` e não é uma alteração, então fica de fora.
 */
export function toGroupUpdated(
  update: Partial<BaileysGroupMetadata>,
): TransportEvents['group.updated'] | null {
  if (!update.id || update.participants) return null;
  const changed: {
    chat: Chat;
    title?: string;
    description?: string | null;
    announce?: boolean;
    restrict?: boolean;
  } = { chat: chatOf(update.id) };
  if (update.subject !== undefined) changed.title = update.subject;
  // Descrição removida chega com `desc` presente e vazio.
  if ('desc' in update) changed.description = update.desc || null;
  if (update.announce !== undefined) changed.announce = update.announce;
  if (update.restrict !== undefined) changed.restrict = update.restrict;
  return Object.keys(changed).length > 1 ? changed : null;
}
