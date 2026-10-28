import type { MessageKey, OutgoingContent } from '@usebridger/core';
import { describe, expect, it } from 'vitest';
import type { SentMessage } from './fake-transport.ts';
import { buildMessage } from './incoming.ts';
import './matchers.ts';

const KEY: MessageKey = { chatId: 'chat@fake', id: 'fake-1', fromMe: true, senderId: null };
const media = Buffer.from('x');

function sent(content: OutgoingContent, reply = false): SentMessage {
  return {
    chatId: 'chat@fake',
    content,
    quoted: reply ? buildMessage({ text: 'pergunta' }) : null,
    mentions: [],
    key: KEY,
  };
}

const text = (value: string, reply = false): SentMessage =>
  sent({ type: 'text', text: value }, reply);

describe('matchers', () => {
  it('toContainText: qualquer texto, igualdade exata ou RegExp', () => {
    const records = [text('olá, mundo')];

    expect(records).toContainText();
    expect(records).toContainText('olá, mundo');
    expect(records).not.toContainText('olá');
    expect(records).toContainText(/mundo/);
    expect([]).not.toContainText();
  });

  it('toContainSticker e toContainImage olham o tipo do conteúdo', () => {
    const records = [sent({ type: 'sticker', media })];

    expect(records).toContainSticker();
    expect(records).not.toContainImage();
    expect([sent({ type: 'image', media })]).toContainImage();
  });

  it('toContainVideo e toContainAudio olham o tipo; a nota de voz não é áudio', () => {
    expect([sent({ type: 'video', media })]).toContainVideo();
    expect([sent({ type: 'audio', media })]).toContainAudio();
    expect([sent({ type: 'voice', media })]).not.toContainAudio();
    expect([sent({ type: 'image', media })]).not.toContainVideo();
  });

  it('toContainDocument filtra por fileName e mimetype, texto ou RegExp', () => {
    const records = [
      sent({ type: 'document', media, fileName: 'juntos.pdf', mimetype: 'application/pdf' }),
    ];

    expect(records).toContainDocument();
    expect(records).toContainDocument({ fileName: 'juntos.pdf' });
    expect(records).toContainDocument({ fileName: /\.pdf$/, mimetype: 'application/pdf' });
    expect(records).not.toContainDocument({ mimetype: 'application/zip' });
    expect(() => expect(records).toContainDocument({ fileName: 'a.pdf' })).toThrow(
      'esperava enviar um documento com fileName "a.pdf"; enviados:\n' +
        '  - <document "juntos.pdf" application/pdf>',
    );
  });

  it('toHaveReplied exige citação; com texto, o conteúdo também', () => {
    expect([text('pong')]).not.toHaveReplied();
    expect([text('pong', true)]).toHaveReplied();
    expect([text('pong', true)]).toHaveReplied('pong');
    expect([text('pong', true)]).not.toHaveReplied('ping');
    expect([sent({ type: 'sticker', media }, true)]).toHaveReplied();
  });

  it('aceita o TestBot (qualquer objeto com sent)', () => {
    expect({ sent: [text('oi', true)] }).toHaveReplied('oi');
  });

  it('a falha lista o que foi enviado', () => {
    const records = [text('oi', true), sent({ type: 'image', media })];

    expect(() => expect(records).toContainSticker()).toThrow(
      'esperava enviar uma figurinha; enviados:\n  - "oi" (resposta)\n  - <image>',
    );
    expect(() => expect([]).toHaveReplied('pong')).toThrow(
      'esperava responder "pong"; nada foi enviado',
    );
    expect(() => expect([text('pong', true)]).not.toHaveReplied()).toThrow(
      'esperava não responder',
    );
  });

  it('valor que não é envio vira erro de uso', () => {
    expect(() => expect('texto').toContainText()).toThrow(/bot\.sent/);
  });
});

describe('toContainTemplate', () => {
  const template = sent({ type: 'template', name: 'retomar_atendimento', language: 'pt_BR' });

  it('passa sem nome, com string e com RegExp; .not quando não casa', () => {
    expect([template]).toContainTemplate();
    expect([template]).toContainTemplate('retomar_atendimento');
    expect([template]).toContainTemplate(/^retomar/);
    expect([template]).not.toContainTemplate('outro');
    expect([text('oi')]).not.toContainTemplate();
  });

  it('a falha descreve o template enviado', () => {
    expect(() => expect([template]).not.toContainTemplate()).toThrow(
      '<template "retomar_atendimento">',
    );
    expect(() => expect([text('oi')]).toContainTemplate('x')).toThrow('enviar um template "x"');
  });
});
