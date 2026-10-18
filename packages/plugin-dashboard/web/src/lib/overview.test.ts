import { describe, expect, it } from 'vitest';
import {
  botChip,
  botName,
  fmtRemaining,
  fmtSince,
  isFatal,
  logOrigin,
  recentLogs,
  stateLabel,
} from './overview.ts';
import type { LogEntry, StatusView } from './types.ts';

const st = (over: Partial<StatusView>): StatusView => ({
  transport: 'whatsapp',
  session: 'default',
  status: 'connecting',
  updatedAt: 0,
  ...over,
});
const log = (message: string, fields?: unknown): LogEntry => ({
  level: 'info',
  time: 0,
  message,
  fields,
});

describe('botChip', () => {
  it('mapeia os estados do transport', () => {
    expect(botChip(st({ status: 'open' })).label).toBe('Conectado');
    expect(botChip(st({ status: 'closed', reason: 'fatal' }))).toEqual({
      label: 'Erro fatal',
      tone: 'danger',
    });
    expect(botChip(st({ status: 'closed', reason: 'replaced' })).label).toBe('Erro fatal');
    expect(botChip(st({ status: 'closed', reason: 'connection-lost' }))).toEqual({
      label: 'Reconectando',
      tone: 'warn',
    });
    expect(isFatal(st({ status: 'closed', reason: 'connection-lost' }))).toBe(false);
    expect(isFatal(st({ status: 'closed', reason: 'auth-failed', pairing: false }))).toBe(true);
    expect(botChip(st({ status: 'closed', reason: 'auth-failed', pairing: true })).label).toBe(
      'Reconectando',
    );
    expect(stateLabel(st({ status: 'open' }))).toBe('Em execução');
    expect(stateLabel(st({ status: 'closed', reason: 'fatal' }))).toBe('Parado');
    expect(botChip(st({ qr: 'x' })).label).toBe('Aguardando pareamento');
    expect(botChip(st({ pairingCode: 'ABCD' })).label).toBe('Aguardando pareamento');
    expect(botChip(st({})).label).toBe('Conectando');
  });
});

describe('logs recentes', () => {
  it('origem vem do campo plugin, com core de fallback', () => {
    expect(logOrigin(log('a', { plugin: 'ai' }))).toBe('ai');
    expect(logOrigin(log('a', { plugin: 1 }))).toBe('core');
    expect(logOrigin(log('a'))).toBe('core');
  });
  it('recentLogs devolve as n mais novas, da mais nova para a mais velha', () => {
    const logs = ['1', '2', '3'].map((m) => log(m));
    expect(recentLogs(logs, 2).map((l) => l.message)).toEqual(['3', '2']);
  });
});

describe('botName', () => {
  it('usa o nome do bot e cai no transport sem ele', () => {
    expect(botName(st({ name: 'luma' }))).toBe('luma');
    expect(botName(st({}))).toBe('whatsapp');
  });
});

describe('fmtRemaining', () => {
  it('formata segundos e minutos; vencido vira undefined', () => {
    expect(fmtRemaining(12_000)).toBe('0:12');
    expect(fmtRemaining(65_000)).toBe('1:05');
    expect(fmtRemaining(0)).toBeUndefined();
    expect(fmtRemaining(-5)).toBeUndefined();
  });
});

describe('fmtSince', () => {
  it('só a hora no mesmo dia; com data em outro dia', () => {
    const at = new Date(2026, 0, 5, 10, 30).getTime();
    expect(fmtSince(at, at + 60_000)).toBe(new Date(at).toLocaleTimeString());
    expect(fmtSince(at, at + 2 * 86_400_000)).toBe(new Date(at).toLocaleString());
  });
});
