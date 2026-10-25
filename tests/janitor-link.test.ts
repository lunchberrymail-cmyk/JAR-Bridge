import { describe, expect, test } from 'bun:test';
import { parseJanitorLink } from '../src/janitor-link';

const characterId = 'abcdef12-3456-7890-abcd-ef1234567890';
const characterUrl = `https://janitorai.com/characters/${characterId}`;
const chatUrl = 'https://janitorai.com/chats/12345';

describe('explicit JanitorAI link parsing', () => {
  test('canonicalizes character links and the observed slug formats', () => {
    for (const input of [characterUrl, `${characterUrl}/`, `${characterUrl}-a-character`, `${characterUrl}_character-a-character`, ` HTTPS://WWW.JANITORAI.COM/characters/${characterId.toUpperCase()}_character-A-Character?utm_source=test#details `]) {
      expect(parseJanitorLink(input)).toEqual({ kind: 'character', characterId, sourceUrl: characterUrl });
    }
  });

  test('accepts a chat or documented numeric message permalink and strips tracking', () => {
    for (const input of [chatUrl, `${chatUrl}/`, `${chatUrl}/messages/999`, `${chatUrl}/messages/999/`, `${chatUrl}?utm_source=copy#message-999`, 'https://www.janitorai.com/chats/12345/messages/999?source=share#message']) {
      expect(parseJanitorLink(input)).toEqual({ kind: 'chat', chatId: '12345', sourceUrl: chatUrl });
    }
  });

  test('never forwards a tracking URL, fragment, or slug as the source URL', () => {
    expect(parseJanitorLink(`${characterUrl}-sample?return=https%3A%2F%2Fexample.com%2F#fragment`).sourceUrl).toBe(characterUrl);
    expect(parseJanitorLink(`${chatUrl}?token=do-not-forward`).sourceUrl).toBe(chatUrl);
  });

  test('rejects nonstrings, bare IDs, malformed links, and unsupported routes', () => {
    for (const input of [undefined, null, 12345, {}, [], '', ' ', characterId, '12345', 'janitorai.com/chats/12345', '//janitorai.com/chats/12345', 'https://janitorai.com', 'https://janitorai.com/', 'https://janitorai.com/my_chats', 'https://janitorai.com/hampter/chats/12345', 'https://janitorai.com/chat/12345', `${chatUrl}/settings`, `${chatUrl}/messages`, `${chatUrl}/messages/nope`, `${characterUrl}/edit`, `${characterUrl}_unrecognized`, `${characterUrl}-`, `${characterUrl}_character-`, 'https://janitorai.com/characters/not-a-uuid']) {
      expect(() => parseJanitorLink(input)).toThrow('Paste a full JanitorAI character or chat link');
    }
  });

  test('requires the exact HTTPS authority without credentials or any explicit port', () => {
    for (const authority of ['http://janitorai.com', 'ftp://janitorai.com', 'https://janitorai.com:443', 'https://janitorai.com:4577', 'https://user@janitorai.com', 'https://user:password@janitorai.com', 'https://janitorai.com@evil.example', 'https://evil.example@janitorai.com', 'https://janitorai.com.evil.example', 'https://api.janitorai.com', 'https://janitorai.com.', 'https://www.www.janitorai.com', 'https://janitorai%2ecom', 'https://janitorai.com%3a443', 'https://janitоrai.com']) {
      expect(() => parseJanitorLink(`${authority}/chats/12345`)).toThrow();
    }
  });

  test('rejects raw or escaped path normalization tricks before any transport can use them', () => {
    for (const path of ['/other/../chats/12345', '/chats/./12345', '/chats/12345/..', '/chats//12345', '//chats/12345', '/chats/%31%32%33%34%35', '/chats/12345%2fmessages%2f999', '/chats/12345%5cmessages%5c999', '/chats/%2e%2e/chats/12345', '/chats/%252e%252e/chats/12345', '/characters/' + characterId + '%2fedit', '/characters/' + characterId + '-a.b', '/characters/' + characterId + '-a/../b']) {
      expect(() => parseJanitorLink(`https://janitorai.com${path}`)).toThrow();
    }
    for (const input of ['https:\\janitorai.com\\chats\\12345', `${chatUrl}\\messages\\999`, `${chatUrl}?redirect=\\evil.example`, `${chatUrl}#\\fragment`]) expect(() => parseJanitorLink(input)).toThrow();
  });

  test('rejects control characters before trimming or URL parsing could hide them', () => {
    for (const control of ['\0', '\t', '\n', '\r', '\u001f', '\u007f', '\u0085', '\u009f']) {
      for (const input of [`${control}${chatUrl}`, `${chatUrl}${control}`, `${chatUrl}?tracking=${control}`, `https://jani${control}torai.com/chats/12345`]) expect(() => parseJanitorLink(input)).toThrow();
    }
    expect(() => parseJanitorLink('https://janitorai.com/chats/12 345')).toThrow();
  });

  test('bounds identities and input size without echoing input in an error', () => {
    const largestId = '9'.repeat(32);
    expect(parseJanitorLink(`https://janitorai.com/chats/${largestId}/messages/${largestId}`)).toEqual({ kind: 'chat', chatId: largestId, sourceUrl: `https://janitorai.com/chats/${largestId}` });
    expect(parseJanitorLink(`${characterUrl}-${'a'.repeat(200)}`).sourceUrl).toBe(characterUrl);
    for (const input of ['https://janitorai.com/chats/0', 'https://janitorai.com/chats/012345', `https://janitorai.com/chats/${'9'.repeat(33)}`, `${chatUrl}/messages/0`, `${chatUrl}/messages/01`, `${chatUrl}/messages/${'9'.repeat(33)}`, `${characterUrl}-${'a'.repeat(201)}`, `${chatUrl}?private=${'x'.repeat(4096)}`]) expect(() => parseJanitorLink(input)).toThrow();
    try { parseJanitorLink('https://private-credential.example/sensitive'); throw new Error('Expected rejection'); }
    catch (error) { expect(String(error)).not.toContain('private-credential'); expect(String(error)).not.toContain('sensitive'); }
  });
});
