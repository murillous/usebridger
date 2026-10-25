// Matchers do Vitest sobre o que o bot enviou. Recebem `bot.sent` ou o próprio `TestBot`
// (`expect(bot).toHaveReplied('pong')`). O registro (`expect.extend`) acontece ao importar
// `@usebridger/testing`, então o exemplo do plano funciona só com o import do `createTestBot`.

import type { OutgoingContent } from '@usebridger/core';
import { expect } from 'vitest';
import type { SentMessage } from './fake-transport.ts';

type TextPattern = string | RegExp;

/** Filtro do `toContainDocument`. */
export interface DocumentExpectation {
  readonly fileName?: TextPattern;
  readonly mimetype?: TextPattern;
}

declare module 'vitest' {
  // Os parâmetros repetem os da declaração do Vitest, como o merge de interfaces exige.
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    /** Algum envio de texto; com `text`, igual à string ou casando com a RegExp. */
    toContainText(text?: TextPattern): R;
    /** Algum envio de figurinha. */
    toContainSticker(): R;
    /** Algum envio de imagem. */
    toContainImage(): R;
    /** Algum envio de vídeo. */
    toContainVideo(): R;
    /** Algum envio de áudio (`audio`; a nota de voz é `voice`, outro tipo). */
    toContainAudio(): R;
    /**
     * Algum envio de documento; com `fileName` ou `mimetype`, um documento com esses valores
     * (texto igual ou casando com a RegExp).
     */
    toContainDocument(expected?: DocumentExpectation): R;
    /** Algum envio de template; com `name`, de nome igual à string ou casando com a RegExp. */
    toContainTemplate(name?: TextPattern): R;
    /**
     * Alguma resposta (envio citando uma mensagem, como faz o `ctx.reply`); com `text`, uma
     * resposta de texto com esse conteúdo.
     */
    toHaveReplied(text?: TextPattern): R;
  }
}

interface Result {
  readonly pass: boolean;
  readonly message: () => string;
}

function sentOf(received: unknown): readonly SentMessage[] {
  if (Array.isArray(received)) return received;
  const sent = (received as { sent?: unknown } | null)?.sent;
  if (Array.isArray(sent)) return sent;
  throw new TypeError('esperava `bot.sent` (ou o TestBot) como valor do expect()');
}

function textMatches(content: OutgoingContent, text: TextPattern | undefined): boolean {
  return content.type === 'text' && patternMatches(content.text, text);
}

function patternMatches(value: string, pattern: TextPattern | undefined): boolean {
  if (pattern === undefined) return true;
  return typeof pattern === 'string' ? value === pattern : pattern.test(value);
}

function documentMatches(content: OutgoingContent, expected: DocumentExpectation): boolean {
  return (
    content.type === 'document' &&
    patternMatches(content.fileName, expected.fileName) &&
    patternMatches(content.mimetype, expected.mimetype)
  );
}

function documentLabel({ fileName, mimetype }: DocumentExpectation): string {
  const parts = [
    ...(fileName === undefined ? [] : [`fileName${label(fileName)}`]),
    ...(mimetype === undefined ? [] : [`mimetype${label(mimetype)}`]),
  ];
  return parts.length === 0 ? '' : ` com ${parts.join(' e ')}`;
}

function describeSent(sent: readonly SentMessage[]): string {
  if (sent.length === 0) return 'nada foi enviado';
  const lines = sent.map(({ content, quoted }) => {
    const body =
      content.type === 'text'
        ? JSON.stringify(content.text)
        : content.type === 'document'
          ? `<document ${JSON.stringify(content.fileName)} ${content.mimetype}>`
          : content.type === 'template'
            ? `<template ${JSON.stringify(content.name)}>`
            : `<${content.type}>`;
    return `  - ${body}${quoted ? ' (resposta)' : ''}`;
  });
  return `enviados:\n${lines.join('\n')}`;
}

function check(
  received: unknown,
  isNot: boolean,
  expected: string,
  predicate: (record: SentMessage) => boolean,
): Result {
  const sent = sentOf(received);
  const pass = sent.some(predicate);
  return {
    pass,
    message: () => `esperava ${isNot ? 'não ' : ''}${expected}; ${describeSent(sent)}`,
  };
}

function label(text: TextPattern | undefined): string {
  if (text === undefined) return '';
  return ` ${typeof text === 'string' ? JSON.stringify(text) : String(text)}`;
}

expect.extend({
  toContainText(received: unknown, text?: TextPattern) {
    return check(received, this.isNot, `enviar o texto${label(text)}`, ({ content }) =>
      textMatches(content, text),
    );
  },
  toContainSticker(received: unknown) {
    return check(
      received,
      this.isNot,
      'enviar uma figurinha',
      ({ content }) => content.type === 'sticker',
    );
  },
  toContainImage(received: unknown) {
    return check(
      received,
      this.isNot,
      'enviar uma imagem',
      ({ content }) => content.type === 'image',
    );
  },
  toContainVideo(received: unknown) {
    return check(
      received,
      this.isNot,
      'enviar um vídeo',
      ({ content }) => content.type === 'video',
    );
  },
  toContainAudio(received: unknown) {
    return check(
      received,
      this.isNot,
      'enviar um áudio',
      ({ content }) => content.type === 'audio',
    );
  },
  toContainDocument(received: unknown, expected: DocumentExpectation = {}) {
    return check(
      received,
      this.isNot,
      `enviar um documento${documentLabel(expected)}`,
      ({ content }) => documentMatches(content, expected),
    );
  },
  toContainTemplate(received: unknown, name?: TextPattern) {
    return check(
      received,
      this.isNot,
      `enviar um template${label(name)}`,
      ({ content }) => content.type === 'template' && patternMatches(content.name, name),
    );
  },
  toHaveReplied(received: unknown, text?: TextPattern) {
    return check(
      received,
      this.isNot,
      `responder${label(text)}`,
      ({ content, quoted }) =>
        quoted !== null && (text === undefined || textMatches(content, text)),
    );
  },
});
