// Despacho do binário `bridger <comando>`; `openapi` e `owner-invite`. O `bridger-bin.ts` o liga ao processo.

import { type CliIo, run } from './openapi.ts';
import { run as ownerInvite } from './owner-invite.ts';

export const USAGE = `Uso: bridger <comando>

Comandos:
  openapi [módulo] [--out <arquivo>]   escreve a spec OpenAPI da API (bridger openapi --help)
  owner-invite <módulo> --email <e-mail>   convite de owner para recuperar o acesso (ADR 0127)`;

/** Despacha o comando e devolve o código de saída. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '-h' || command === '--help') {
    io.out(USAGE);
    return 0;
  }
  if (command === 'openapi') return run(rest, io);
  if (command === 'owner-invite') return ownerInvite(rest, io);
  io.err(`Comando desconhecido: ${command}\n\n${USAGE}`);
  return 1;
}
