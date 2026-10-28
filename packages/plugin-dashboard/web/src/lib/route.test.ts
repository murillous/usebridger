import { expect, it } from 'vitest';
import { hashParam, href, parseRoute } from './route.ts';

it('parseRoute decodifica os segmentos e ignora a query do hash', () => {
  expect(parseRoute('#/recursos/rank/item%2F1')).toEqual(['recursos', 'rank', 'item/1']);
  expect(parseRoute('#/convite?token=abc')).toEqual(['convite']);
  expect(parseRoute('')).toEqual([]);
  expect(parseRoute('#/a/%E0')).toEqual(['a', '%E0']);
});

it('href escapa e hashParam lê a query do hash', () => {
  expect(href('recursos', 'rank', 'a/b')).toBe('#/recursos/rank/a%2Fb');
  expect(hashParam('#/convite?token=a%2Bb', 'token')).toBe('a+b');
  expect(hashParam('#/convite', 'token')).toBeUndefined();
});
