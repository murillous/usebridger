// Unidade de `createPluginControl` com host, configs e catálogo falsos; o fluxo ponta a ponta pelo
// `Bot` fica em `plugin-control.test.ts`.
import { describe, expect, it, vi } from 'vitest';
import type { PluginConfigs } from '#config/plugin-configs.ts';
import type { PluginChangeResult, PluginHost } from '#plugin/host.ts';
import { PluginLifecycleError, type PluginReportEntry } from '#plugin/report.ts';
import { BotStateError } from './config.ts';
import { createPluginControl } from './plugin-control.ts';

const loaded = (name: string): PluginReportEntry => ({
  name,
  version: '1.0.0',
  origin: 'config',
  status: 'loaded',
});
const disabled = (name: string): PluginReportEntry => ({
  name,
  version: '1.0.0',
  origin: 'config',
  status: 'skipped',
  reason: { kind: 'disabled' },
});
const dependencySkipped = (name: string): PluginReportEntry => ({
  name,
  version: '1.0.0',
  origin: 'config',
  status: 'skipped',
  reason: { kind: 'dependency-skipped', dependency: 'x' },
});
const failed = (name: string, error: PluginLifecycleError): PluginReportEntry => ({
  name,
  version: '1.0.0',
  origin: 'config',
  status: 'skipped',
  reason: { kind: 'setup-failed', error },
});

function setup(options: { table?: PluginReportEntry[]; result?: PluginChangeResult } = {}) {
  const table = options.table ?? [];
  const result: PluginChangeResult = options.result ?? {
    plugin: loaded('a'),
    dependents: [],
    teardownErrors: [],
  };
  const host = {
    report: () => table,
    reload: vi.fn(async () => result),
    disable: vi.fn(async () => result),
    enable: vi.fn(async () => result),
  } as unknown as PluginHost;
  const configs = {
    setOverrides: vi.fn(),
    describe: vi.fn(() => 'descrição'),
    jsonSchema: vi.fn(() => ({})),
  } as unknown as PluginConfigs;
  const booted: { host: PluginHost | undefined; configs: PluginConfigs | undefined } = {
    host: undefined,
    configs: undefined,
  };
  const sweep = vi.fn();
  const lifecycleError = vi.fn();
  const control = createPluginControl({
    host: () => booted.host,
    configs: () => booted.configs,
    state: () => 'idle',
    catalog: { batch: (fn) => fn() },
    conversations: { sweep },
    lifecycleError,
  });
  return { control, host, configs, booted, sweep, lifecycleError };
}

describe('createPluginControl antes do boot', () => {
  it('reload, disable e enable rejeitam com BotStateError', async () => {
    const { control } = setup();
    for (const action of ['reload', 'disable', 'enable'] as const) {
      const promise = control.plugins[action]('a');
      await expect(promise).rejects.toBeInstanceOf(BotStateError);
      await expect(promise).rejects.toThrow(`${action}("a"): plugins ainda não carregados`);
    }
  });

  it('config lança BotStateError com o método', () => {
    const { control } = setup();
    expect(() => control.config.describe('a')).toThrow(BotStateError);
    expect(() => control.config.describe('a')).toThrow(
      'config.describe(): plugins ainda não carregados (start)',
    );
    expect(() => control.config.setOverrides('a', {})).toThrow('config.setOverrides()');
    expect(() => control.config.jsonSchema('a')).toThrow('config.jsonSchema()');
  });

  it('plugins() devolve lista vazia', () => {
    expect(setup().control.plugins()).toEqual([]);
  });
});

describe('createPluginControl depois do boot', () => {
  it('config delega às configs', () => {
    const ctx = setup();
    ctx.booted.configs = ctx.configs;
    expect(ctx.control.config.describe('a')).toBe('descrição');
    expect(ctx.configs.describe).toHaveBeenCalledWith('a');
  });

  it('plugins() devolve a tabela do host', () => {
    const ctx = setup({ table: [loaded('a')] });
    ctx.booted.host = ctx.host;
    expect(ctx.control.plugins()).toEqual([loaded('a')]);
  });

  it('presence: loaded, disabled, down e absent', () => {
    const ctx = setup({
      table: [
        loaded('a'),
        disabled('b'),
        dependencySkipped('c'),
        failed('d', new PluginLifecycleError('d', 'setup', 'x', false)),
      ],
    });
    expect(ctx.control.presence('a')).toBe('absent');
    ctx.booted.host = ctx.host;
    expect(ctx.control.presence('a')).toBe('loaded');
    expect(ctx.control.presence('b')).toBe('disabled');
    expect(ctx.control.presence('c')).toBe('down');
    expect(ctx.control.presence('d')).toBe('down');
    expect(ctx.control.presence('z')).toBe('absent');
  });

  it('change varre as esperas e reporta teardown e setup-failed do plugin e dos dependentes', async () => {
    const teardown = new PluginLifecycleError('a', 'teardown', 'boom', false);
    const own = new PluginLifecycleError('a', 'setup', 'falhou', false);
    const dep = new PluginLifecycleError('b', 'setup', 'falhou', false);
    const result: PluginChangeResult = {
      plugin: failed('a', own),
      dependents: [failed('b', dep), loaded('c')],
      teardownErrors: [teardown],
    };
    const ctx = setup({ result });
    ctx.booted.host = ctx.host;
    await expect(ctx.control.plugins.reload('a')).resolves.toBe(result);
    expect(ctx.host.reload).toHaveBeenCalledWith('a');
    expect(ctx.sweep).toHaveBeenCalledWith(ctx.control.presence);
    expect(ctx.lifecycleError.mock.calls.map(([error]) => error)).toEqual([teardown, own, dep]);
  });

  it('disable e enable chamam a ação certa do host', async () => {
    const ctx = setup();
    ctx.booted.host = ctx.host;
    await ctx.control.plugins.disable('a');
    await ctx.control.plugins.enable('a');
    expect(ctx.host.disable).toHaveBeenCalledWith('a');
    expect(ctx.host.enable).toHaveBeenCalledWith('a');
    expect(ctx.lifecycleError).not.toHaveBeenCalled();
  });
});
