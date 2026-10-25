import { describe, expect, test } from 'bun:test';
import { ChatFileError, MAX_CHAT_FILE_BYTES, parseChatFile, parseChatHistory } from '../src/chat-file';

const characterId = 'abcdef12-3456-7890-abcd-ef1234567890';
const timestamp = (minute: number) => `2025-01-01T10:${String(minute).padStart(2, '0')}:00.999Z`;
function archive() {
  return {
    chat: { id: 12345, character_id: characterId, name: 'A saved conversation', created_at: timestamp(0) },
    character: { id: characterId, name: 'Mira', system_prompt: 'PRIVATE_CARD_DEFINITION' },
    personas: [{ name: 'Avery', is_default: true, description: 'PRIVATE_PERSONA' }],
    settings: { secret: 'PRIVATE_SETTINGS' },
    chatMessages: [
      { chat_id: 12345, is_bot: true, is_main: false, message: '  Earlier {{user}} alternative  ', created_at: timestamp(0) },
      { chat_id: 12345, is_bot: true, is_main: true, message: '\nSelected reply {{char}}\n', created_at: timestamp(1) },
      { chat_id: 12345, is_bot: false, message: 'User reply', created_at: timestamp(2) },
      { chat_id: 12345, is_bot: true, message: 'Final reply', created_at: timestamp(3) },
    ],
  };
}

describe('chat history file import', () => {
  test('previews a JAR JSON download locally while preserving literal text, selection and dates', async () => {
    const chat = await parseChatFile(new File([JSON.stringify(archive())], 'saved-chat.json'));
    expect(chat.name).toBe('A saved conversation');
    expect(chat.messages).toHaveLength(3);
    expect(chat.messages.map(row => row.is_user)).toEqual([false, true, false]);
    expect(chat.messages[0].content).toBe('\nSelected reply {{char}}\n');
    expect(chat.messages[0].swipes).toEqual(['\nSelected reply {{char}}\n', '  Earlier {{user}} alternative  ']);
    expect(chat.messages[0].swipe_dates).toEqual([1, 0].map(minute => Math.floor(Date.parse(timestamp(minute)) / 1000)));
    expect(chat.messages[0].send_date).toBe(Math.floor(Date.parse(timestamp(1)) / 1000));
    expect(chat.messages[0].name).toBe('Mira');
    expect(chat.messages[1].name).toBe('Avery');
    expect(chat.metadata).toEqual({ imported_from: 'janitorai', janitor_chat_id: 12345, janitor_character_id: characterId });
    expect(JSON.stringify(chat)).not.toContain('PRIVATE');
  });

  test('orders raw messages by precise timestamps and keeps consecutive user messages separate', () => {
    const raw = archive();
    raw.chatMessages = [
      { chat_id: 12345, is_bot: false, message: 'Second user', created_at: timestamp(1) },
      { chat_id: 12345, is_bot: false, message: 'First user', created_at: timestamp(0) },
    ];
    expect(parseChatHistory(JSON.stringify(raw)).messages.map(row => row.content)).toEqual(['First user', 'Second user']);
  });

  test('rejects conflicting identities, invalid dates and malformed messages instead of skipping them', () => {
    for (const mutate of [
      (raw: ReturnType<typeof archive>) => { raw.chat.character_id = 'different-character'; },
      (raw: ReturnType<typeof archive>) => { raw.chatMessages[0].chat_id = 67890; },
      (raw: ReturnType<typeof archive>) => { raw.chatMessages[0].created_at = '2025-02-30T10:00:00Z'; },
      (raw: ReturnType<typeof archive>) => { (raw.chatMessages[0] as any).is_bot = 'true'; },
      (raw: ReturnType<typeof archive>) => { (raw.chatMessages[0] as any).message = null; },
    ]) {
      const raw = archive(); mutate(raw);
      expect(() => parseChatHistory(JSON.stringify(raw))).toThrow(ChatFileError);
    }
  });

  test('accepts JSONL with alternate replies and rejects a malformed row', async () => {
    const jsonl = [
      { user_name: 'Avery', character_name: 'Mira', chat_metadata: { imported_from: 'janitorai', janitor_chat_id: '12345' } },
      { name: 'Mira', is_user: false, mes: 'Selected', swipes: ['Old', 'Selected'], swipe_id: 1, swipe_dates: [timestamp(0), timestamp(1)] },
      { name: 'Avery', is_user: true, mes: 'Hello {{char}}', send_date: timestamp(2) },
    ].map(row => JSON.stringify(row)).join('\n');
    const chat = await parseChatFile(new File([jsonl], 'saved-chat.jsonl'));
    expect(chat.messages).toHaveLength(2);
    expect(chat.messages[0].content).toBe('Selected');
    expect(chat.messages[0].swipe_id).toBe(1);
    expect(chat.messages[0].swipes).toEqual(['Old', 'Selected']);
    expect(() => parseChatHistory(jsonl + '\ninvalid-json')).toThrow(ChatFileError);
  });

  test('rejects empty, oversized and unsupported files before import', async () => {
    await expect(parseChatFile(new File([], 'empty.json'))).rejects.toBeInstanceOf(ChatFileError);
    await expect(parseChatFile(new File(['text'], 'not-history.txt'))).rejects.toBeInstanceOf(ChatFileError);
    await expect(parseChatFile(new File(['x'.repeat(MAX_CHAT_FILE_BYTES + 1)], 'large.json'))).rejects.toBeInstanceOf(ChatFileError);
    await expect(parseChatFile(new File(['{"unsupported":true}'], 'wrong.json'))).rejects.toBeInstanceOf(ChatFileError);
  });
});
