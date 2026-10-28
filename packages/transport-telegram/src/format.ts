// Texto formatado neutro do core (ADR 0057) no HTML da Bot API (`parse_mode: 'HTML'`). Função
// pura. O HTML exige escape só de `&`, `<` e `>`, mais simples que o do MarkdownV2.

import type { FormattedText, TextNode } from '@usebridger/core';

export function renderHtml(text: FormattedText): string {
  return render(text.nodes);
}

function render(nodes: readonly TextNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (typeof node === 'string') {
      out += escapeHtml(node);
      continue;
    }
    switch (node.type) {
      case 'bold':
        out += `<b>${render(node.children)}</b>`;
        break;
      case 'italic':
        out += `<i>${render(node.children)}</i>`;
        break;
      case 'code':
        out += `<code>${escapeHtml(node.text)}</code>`;
        break;
      case 'link':
        out += `<a href="${escapeAttr(node.url)}">${render(node.children)}</a>`;
        break;
      case 'mention': {
        // O link `tg://user` notifica pelo ID, inclusive quem não tem `@usuario`.
        const { id, name, username } = node.contact;
        const label = username !== undefined ? `@${username}` : (name ?? id);
        out += `<a href="tg://user?id=${escapeAttr(id)}">${escapeHtml(label)}</a>`;
        break;
      }
    }
  }
  return out;
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replaceAll('"', '&quot;');
}
