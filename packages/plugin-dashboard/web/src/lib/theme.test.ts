import { describe, expect, it } from 'vitest';
import { applyTheme, loadTheme, saveTheme } from './theme.ts';

const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
};
const blocked = () => {
  throw new Error('bloqueado');
};
const broken = { getItem: blocked, setItem: blocked, removeItem: blocked };

describe('tema', () => {
  it('guarda e lê; auto limpa; valor estranho vira auto', () => {
    const store = memory();
    expect(loadTheme(store)).toBe('auto');
    saveTheme('dark', store);
    expect(loadTheme(store)).toBe('dark');
    store.setItem('bridger-dashboard-theme', 'roxo');
    expect(loadTheme(store)).toBe('auto');
    saveTheme('light', store);
    saveTheme('auto', store);
    expect(loadTheme(store)).toBe('auto');
  });

  it('storage que lança não quebra', () => {
    expect(loadTheme(broken)).toBe('auto');
    expect(saveTheme('dark', broken)).toBe(false);
  });

  it('aplica o atributo no elemento raiz', () => {
    const attrs = new Map<string, string>();
    const root = {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
    } as unknown as HTMLElement;
    applyTheme('dark', root);
    expect(attrs.get('data-theme')).toBe('dark');
    applyTheme('auto', root);
    expect(attrs.has('data-theme')).toBe(false);
  });
});
