// Menu de comandos do Telegram (`setMyCommands`, ADR 0060). Função pura: monta as listas por
// escopo, e o transport só chama a API quando elas mudam.

import type { CommandInfo } from '@usebridger/core';
import type { BotCommand } from 'grammy/types';

/** Nome que o Telegram aceita no menu. */
const NAME = /^[a-z0-9_]{1,32}$/;
/** Limite da descrição na Bot API. */
const MAX_DESCRIPTION = 256;

export interface CommandMenus {
  /** Escopo padrão: todos veem. */
  readonly everyone: readonly BotCommand[];
  /** Escopo `all_chat_administrators`: substitui o padrão para os admins, então leva os dois. */
  readonly admins: readonly BotCommand[];
  /** Nomes que ficaram de fora por não caberem nas regras do Telegram. */
  readonly skipped: readonly string[];
}

/**
 * Só o `name` vai ao menu; o alias segue valendo digitado. `owner` e papéis custom ficam fora:
 * o Telegram não tem como mostrá-los só a quem pode.
 */
export function commandMenus(commands: readonly CommandInfo[]): CommandMenus {
  const everyone: BotCommand[] = [];
  const admins: BotCommand[] = [];
  const skipped: string[] = [];
  for (const info of commands) {
    if (info.role !== 'everyone' && info.role !== 'group-admin') continue;
    if (!NAME.test(info.name)) {
      skipped.push(info.name);
      continue;
    }
    // A descrição é obrigatória no Telegram (1 a 256 caracteres).
    const description = (info.description?.trim() || info.name).slice(0, MAX_DESCRIPTION);
    const entry = { command: info.name, description };
    if (info.role === 'everyone') everyone.push(entry);
    admins.push(entry);
  }
  return { everyone, admins, skipped };
}
