import { describe, expect, it } from 'vitest';
import { Fifo } from './fifo.ts';

describe('Fifo', () => {
  it('sai na ordem de entrada, com peek sem remover', () => {
    const fifo = new Fifo<number>();
    expect(fifo.peek()).toBeUndefined();
    expect(fifo.shift()).toBeUndefined();
    fifo.push(1);
    fifo.push(2);
    expect(fifo.peek()).toBe(1);
    expect(fifo.size).toBe(2);
    expect(fifo.shift()).toBe(1);
    expect(fifo.shift()).toBe(2);
    expect(fifo.size).toBe(0);
    expect(fifo.shift()).toBeUndefined();
  });

  it('clear esvazia', () => {
    const fifo = new Fifo<string>();
    fifo.push('a');
    fifo.push('b');
    fifo.shift();
    fifo.clear();
    expect(fifo.size).toBe(0);
    expect(fifo.peek()).toBeUndefined();
    fifo.push('c');
    expect(fifo.shift()).toBe('c');
  });

  it('mantém ordem e tamanho através da compactação depois de 1024 consumidos', () => {
    const fifo = new Fifo<number>();
    for (let i = 0; i < 3000; i++) fifo.push(i);
    for (let i = 0; i < 2000; i++) expect(fifo.shift()).toBe(i);
    expect(fifo.size).toBe(1000);
    expect(fifo.peek()).toBe(2000);
    fifo.push(3000);
    for (let i = 2000; i <= 3000; i++) expect(fifo.shift()).toBe(i);
    expect(fifo.size).toBe(0);
  });
});
