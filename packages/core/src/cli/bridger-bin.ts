#!/usr/bin/env node
import { main } from './bridger.ts';

// Sai explicitamente: um handle aberto do plugin (setInterval no setup ou no import) seguraria o
// processo. O exit vai no callback do último write para não truncar a saída em pipe.
const code = await main(process.argv.slice(2), {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
