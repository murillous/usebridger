// Eventos de log do transport (ADR 0118), importados como `import * as LOG`. O nome é contrato
// com o agregador: evento novo é minor; renomear ou remover quebra.

import { defineLogEvent, type LogEvent } from '@usebridger/core';

// Comum a todo transport: o mesmo nome no core e nos outros transports.
export const handlerFailed: LogEvent = defineLogEvent({
  name: 'transport.handler.failed',
  level: 'error',
  message: 'handler de evento do transport falhou',
});

export const credsSaveFailed: LogEvent = defineLogEvent({
  name: 'baileys.creds.save-failed',
  level: 'error',
  message: 'falha ao gravar as credenciais da sessão',
});
export const messageNormalizeFailed: LogEvent = defineLogEvent({
  name: 'baileys.message.normalize-failed',
  level: 'error',
  message: 'falha ao normalizar mensagem do Baileys; descartada',
});
export const contactsLearnFailed: LogEvent = defineLogEvent({
  name: 'baileys.contacts.learn-failed',
  level: 'error',
  message: 'falha ao aprender nomes de contatos do Baileys; descartados',
});
export const reactionConvertFailed: LogEvent = defineLogEvent({
  name: 'baileys.reaction.convert-failed',
  level: 'error',
  message: 'falha ao converter reação do Baileys; descartada',
});
export const editConvertFailed: LogEvent = defineLogEvent({
  name: 'baileys.edit.convert-failed',
  level: 'error',
  message: 'falha ao converter edição do Baileys; descartada',
});
export const deleteConvertFailed: LogEvent = defineLogEvent({
  name: 'baileys.delete.convert-failed',
  level: 'error',
  message: 'falha ao converter apagamento do Baileys; descartado',
});
export const groupJoinedFailed: LogEvent = defineLogEvent({
  name: 'baileys.group.joined-failed',
  level: 'error',
  message: 'falha ao repassar grupo novo',
});
export const groupUpdatedFailed: LogEvent = defineLogEvent({
  name: 'baileys.group.updated-failed',
  level: 'error',
  message: 'falha ao repassar alteração de grupo',
});
export const participantsConvertFailed: LogEvent = defineLogEvent({
  name: 'baileys.participants.convert-failed',
  level: 'error',
  message: 'falha ao converter alteração de participantes do Baileys; descartada',
});
export const pollVoteUnknown: LogEvent = defineLogEvent({
  name: 'baileys.poll.vote-unknown',
  level: 'debug',
  message: 'voto de enquete desconhecida; descartado',
});
export const socketEndFailed: LogEvent = defineLogEvent({
  name: 'baileys.socket.end-failed',
  level: 'warn',
  message: 'falha ao encerrar o socket do Baileys',
});
export const lidResolveFailed: LogEvent = defineLogEvent({
  name: 'baileys.lid.resolve-failed',
  level: 'warn',
  message: 'falha ao resolver o telefone de um LID',
});
export const pairingCodeFailed: LogEvent = defineLogEvent({
  name: 'baileys.pairing-code.failed',
  level: 'error',
  message: 'falha ao pedir o código de pareamento',
});
export const contactNamesSaveFailed: LogEvent = defineLogEvent({
  name: 'baileys.contact-names.save-failed',
  level: 'warn',
  message: 'falha ao gravar os nomes de contatos; tenta de novo na próxima gravação',
});
export const contactNamesReadFailed: LogEvent = defineLogEvent({
  name: 'baileys.contact-names.read-failed',
  level: 'warn',
  message: 'falha ao ler os nomes de contatos do auth state; segue sem nome',
});
export const versionFetchFailed: LogEvent = defineLogEvent({
  name: 'baileys.version.fetch-failed',
  level: 'warn',
  message: 'não deu para buscar a versão do WhatsApp Web; usando a do Baileys',
});
