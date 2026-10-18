import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DASHBOARD_VERSION } from './version.ts';

it('DASHBOARD_VERSION acompanha a versão do package.json', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  expect(DASHBOARD_VERSION).toBe(manifest.version);
});
