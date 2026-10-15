import { describe, expect, it } from 'vitest';
import { ReadyGate } from './ready-gate.ts';

describe('ReadyGate', () => {
  it('começa não pronto', () => {
    expect(new ReadyGate().ready).toBe(false);
  });

  it('settle(true) deixa pronto e a promessa resolve true', async () => {
    const gate = new ReadyGate();
    gate.settle(true);
    expect(gate.ready).toBe(true);
    expect(await gate.promise).toBe(true);
  });

  it('settle(false) depois de settle(true) é ignorado', async () => {
    const gate = new ReadyGate();
    gate.settle(true);
    gate.settle(false);
    expect(gate.ready).toBe(true);
    expect(await gate.promise).toBe(true);
  });

  it('settle(false) primeiro mantém não pronto e ignora settle(true) depois', async () => {
    const gate = new ReadyGate();
    gate.settle(false);
    gate.settle(true);
    expect(gate.ready).toBe(false);
    expect(await gate.promise).toBe(false);
  });
});
