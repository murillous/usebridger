#!/usr/bin/env node
// Binário `bridger <comando>`; hoje só `openapi`. Ninguém o importa como biblioteca.

import { run, USAGE } from './openapi.ts';

const [command, ...rest] = process.argv.slice(2);
if (command === 'openapi') {
  process.exitCode = await run(rest, {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  });
} else {
  process.stderr.write(`Comando desconhecido: ${command ?? '(nenhum)'}\n\n${USAGE}\n`);
  process.exitCode = 1;
}
