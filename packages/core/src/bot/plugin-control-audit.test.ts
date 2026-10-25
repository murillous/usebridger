// Auditoria do `setOverrides` no `createPluginControl` (ADR 0122): ordem, diff e falha de leitura.
import { describe, expect, it, vi } from 'vitest';
import { runAsAuditSubject } from '#audit/scope.ts';
import type { InternalRecordInput } from '#audit/types.ts';
import type { PluginConfigs } from '#config/plugin-configs.ts';
import type { PluginHost } from '#plugin/host.ts';
import { createPluginControl } from './plugin-control.ts';

function setup(describeImpl: (state: { label: string }, call: number) => Promise<unknown>) {
  const state = { label: 'a' };
  const applied: string[] = [];
  let describeCalls = 0;
  const configs = {
    describe: vi.fn(async () => ({ config: await describeImpl(state, describeCalls++) })),
    setOverrides: vi.fn(async (_plugin: string, overrides: { label: string }) => {
      applied.push(overrides.label);
      state.label = overrides.label;
      return undefined;
    }),
  } as unknown as PluginConfigs;
  const records: InternalRecordInput[] = [];
  const event = vi.fn();
  const control = createPluginControl({
    host: () => ({}) as PluginHost,
    configs: () => configs,
    state: () => 'running',
    catalog: { batch: (fn) => fn() },
    conversations: { sweep: vi.fn() },
    lifecycleError: vi.fn(),
    audit: { record: (input) => void records.push(input) },
    log: () => ({ event }) as never,
  });
  return { control, records, applied, event };
}

describe('setOverrides auditado', () => {
  it('duas chamadas sem await aplicam na ordem e cada diff tem só a própria mudança', async () => {
    const { control, records, applied } = setup(async (state, call) => {
      // A leitura "antes" da primeira é a mais lenta.
      if (call === 0) await new Promise((resolve) => setTimeout(resolve, 20));
      return { label: state.label };
    });
    const first = control.config.setOverrides('p', { label: 'b' });
    const second = control.config.setOverrides('p', { label: 'c' });
    await Promise.all([first, second]);
    expect(applied).toEqual(['b', 'c']);
    expect(records.map((r) => r.details?.['changes'])).toEqual([
      { label: { from: 'a', to: 'b' } },
      { label: { from: 'b', to: 'c' } },
    ]);
  });

  it('falha de leitura segue a ação, registra o log e grava changes: null', async () => {
    const { control, records, applied, event } = setup(async (state, call) => {
      if (call === 0) throw new Error('leitura quebrou');
      return { label: state.label };
    });
    await control.config.setOverrides('p', { label: 'b' });
    expect(applied).toEqual(['b']);
    expect(records[0]).toMatchObject({
      outcome: 'success',
      details: { plugin: 'p', changes: null },
    });
    expect(event).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'audit.config-diff.failed' }),
      expect.objectContaining({ plugin: 'p' }),
    );
  });

  it('com titular no escopo, o ator explícito do as() não é passado', async () => {
    const { control, records } = setup(async (state) => ({ label: state.label }));
    const admin = control.as({ kind: 'plugin', name: 'dash' });
    await admin.config.setOverrides('p', { label: 'b' });
    await runAsAuditSubject({ kind: 'user', id: 'u', name: 'Ana' } as never, () =>
      admin.config.setOverrides('p', { label: 'c' }),
    );
    expect(records[0]?.actor).toEqual({ kind: 'plugin', name: 'dash' });
    expect(records[1]?.actor).toBeUndefined();
  });
});
