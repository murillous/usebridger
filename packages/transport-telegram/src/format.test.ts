import { bold, code, fmt, italic, link, mention } from '@usebridger/core';
import { describe, expect, it } from 'vitest';
import { renderHtml } from './format.ts';

describe('renderHtml', () => {
  it('escapa o texto literal e aninha as marcas', () => {
    expect(renderHtml(fmt`a & <b> ${bold(fmt`x ${italic('y')}`)} ${code('<i>')}`)).toBe(
      'a &amp; &lt;b&gt; <b>x <i>y</i></b> <code>&lt;i&gt;</code>',
    );
  });

  it('link escapa as aspas da URL', () => {
    expect(renderHtml(fmt`${link('https://x/?a="1"&b', 'aqui')}`)).toBe(
      '<a href="https://x/?a=&quot;1&quot;&amp;b">aqui</a>',
    );
  });

  it('menção usa o @usuario como rótulo quando há, e o ID no link', () => {
    expect(
      renderHtml(fmt`${mention({ id: '9', name: 'Bia', phone: null, username: 'bia' })}`),
    ).toBe('<a href="tg://user?id=9">@bia</a>');
  });
});
