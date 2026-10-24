#!/usr/bin/env node
// `bridger-pseudonym <id>`: calcula o pseudônimo que um id (JID, LID, telefone) tem nos logs, para
// começar uma investigação ("o cliente 5565... reclamou") buscando o pseudônimo no Loki (ADR 0119).
// Só vai do id ao pseudônimo; a chave vem de `BRIDGER_SECRET_KEY`, a mesma do bot.

import { parseArgs } from 'node:util';
import { type ConfigEnv, processEnv, readSecretKeys } from '#config/env.ts';
import { BotConfigError } from '#config/owners.ts';
import { createPseudonymizer } from '#logger/pseudonym.ts';

const USAGE = `Uso: bridger-pseudonym [--group] <id>

Mostra o pseudônimo de um id de usuário (u_…) ou de grupo (g_…, com --group) nos logs.
Passe o id como o transport o usa, por inteiro: 5565999998888@s.whatsapp.net, 123@lid, 120363@g.us.
Usa a BRIDGER_SECRET_KEY do ambiente: precisa ser a mesma do bot.`;

/** Saída do CLI; o `main` liga ao terminal e os testes capturam. */
export interface CliIo {
  readonly env: ConfigEnv;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** Roda o comando e devolve o código de saída. */
export function run(argv: readonly string[], io: CliIo): number {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    // Opção desconhecida: o parseArgs explica qual; o uso mostra as válidas.
    io.err(`${(error as Error).message}\n\n${USAGE}`);
    return 1;
  }
  if (parsed.values.help) {
    io.out(USAGE);
    return 0;
  }
  const [id] = parsed.positionals;
  if (id === undefined || parsed.positionals.length > 1) {
    io.err(USAGE);
    return 1;
  }
  try {
    const { current } = readSecretKeys(io.env);
    if (current === undefined) {
      io.err('BRIDGER_SECRET_KEY não definida: sem ela o pseudônimo não bate com o dos logs.');
      return 1;
    }
    const { pseudonym } = createPseudonymizer(() => current);
    io.out(pseudonym(id, parsed.values.group ? 'group' : 'user'));
    return 0;
  } catch (error) {
    // Chave malformada: a mensagem não ecoa o valor (ver `parseSecretKey`).
    if (error instanceof BotConfigError) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' }, group: { type: 'boolean', short: 'g' } },
  });
}

if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2), {
    env: processEnv(),
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  });
}
