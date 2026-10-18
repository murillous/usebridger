// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Plugins } from './Plugins.tsx';

// `SELF` é const de módulo, lida de `document.baseURI` no import: o `<base>` precisa existir antes
// dos imports estáticos (o vi.hoisted sobe acima deles). Sem vi.resetModules, que duplicaria o React.
const base = vi.hoisted(() => {
  const b = document.createElement('base');
  b.href = 'http://localhost/plugins/dashboard/';
  document.head.append(b);
  return b;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(() => base.remove());

const loaded = (name: string) => ({
  name,
  version: '1.0.0',
  origin: `/plugins/${name}`,
  status: 'loaded' as const,
});

describe('Plugins: o próprio painel', () => {
  it('fica travado: switch desabilitado e sem Recarregar', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url === 'api/plugins'
        ? new Response(JSON.stringify([loaded('dashboard'), loaded('outro')]))
        : new Response('', { status: 500 }),
    );
    render(<Plugins />);
    const table = await screen.findByRole('table');
    const row = (name: string) => within(table).getByRole('row', { name: new RegExp(`^${name} `) });
    const sw = (name: string) =>
      within(row(name)).getByRole('switch', { name: `Ativo: ${name}` }) as HTMLButtonElement;
    expect(sw('dashboard').disabled).toBe(true);
    expect(sw('outro').disabled).toBe(false);
    expect(within(row('dashboard')).queryByRole('button', { name: /^Recarregar/ })).toBeNull();
    expect(within(row('outro')).getByRole('button', { name: 'Recarregar outro' })).toBeTruthy();
  });
});
