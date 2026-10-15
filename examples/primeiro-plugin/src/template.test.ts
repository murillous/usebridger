import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Os arquivos deste exemplo são o que o `create-bridger-plugin` gera para `bridger-plugin-ola`.
// Se o template mudar e o exemplo não, a página do getting started mostraria código que o
// gerador já não produz. Só as marcas de região (`// #region`), que o site usa, ficam de fora. A substituição é a mesma de `generate()` em packages/create-plugin.
const template = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'packages',
  'create-plugin',
  'template',
);

it.each(['index.ts', 'index.test.ts'])(
  'src/%s acompanha o template do create-plugin',
  (arquivo) => {
    const gerado = readFileSync(join(template, 'src', arquivo), 'utf8')
      .replaceAll('__package__', 'bridger-plugin-ola')
      .replaceAll('__name__', 'ola')
      .replaceAll('__export__', 'ola');
    const exemplo = readFileSync(join(import.meta.dirname, arquivo), 'utf8').replace(
      /^\/\/ #(end)?region .*\n/gm,
      '',
    );
    expect(exemplo).toBe(gerado);
  },
);
