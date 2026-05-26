import { describe, expect, it } from 'vitest';
import { HistoryReq, Profile, RoomDeleteMsgReq, RoomEditMsgReq, RoomHistoryReq, RoomMessage, RoomSendReq, ScreenName } from './schemas.js';

describe('shared schemas', () => {
  const roomId = '11111111-1111-4111-8111-111111111111';
  const channelId = '22222222-2222-4222-8222-222222222222';
  const msgId = '33333333-3333-4333-8333-333333333333';

  it('applies safe defaults for history requests', () => {
    expect(HistoryReq.parse({ peerId: 'peer-12345678' })).toMatchObject({
      peerId: 'peer-12345678',
      limit: 100,
    });
    expect(RoomHistoryReq.parse({ roomId })).toMatchObject({
      roomId,
      limit: 200,
    });
  });

  it('caps history limits at the IPC boundary', () => {
    expect(() => HistoryReq.parse({ peerId: 'peer-12345678', limit: 501 })).toThrow();
    expect(() => RoomHistoryReq.parse({ roomId, limit: 501 })).toThrow();
  });

  it('keeps screen names in the AIM-style safe character set', () => {
    expect(ScreenName.parse('Tristan G.')).toBe('Tristan G.');
    expect(() => ScreenName.parse('<script>')).toThrow();
  });

  it('accepts empty or image data URLs for profile media', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(Profile.parse({ avatarDataUrl: '', bgImageDataUrl: png })).toMatchObject({
      avatarDataUrl: '',
      bgImageDataUrl: png,
    });
  });

  it('rejects non-image profile media payloads', () => {
    expect(() => Profile.parse({ avatarDataUrl: 'javascript:alert(1)' })).toThrow();
    expect(() => Profile.parse({ bgImageDataUrl: 'data:text/html;base64,PHNjcmlwdD4=' })).toThrow();
  });

  it('keeps room edit limits aligned with room sends', () => {
    const maxBody = 'x'.repeat(64 * 1024);
    expect(RoomSendReq.parse({ roomId, channelId, body: maxBody })).toMatchObject({ body: maxBody });
    expect(RoomEditMsgReq.parse({ roomId, msgId, body: maxBody })).toMatchObject({ body: maxBody });

    const tooLarge = `${maxBody}x`;
    expect(() => RoomSendReq.parse({ roomId, channelId, body: tooLarge })).toThrow();
    expect(() => RoomEditMsgReq.parse({ roomId, msgId, body: tooLarge })).toThrow();
  });

  it('validates room message action payloads', () => {
    expect(RoomEditMsgReq.parse({ roomId, msgId, body: 'fixed typo' })).toMatchObject({
      roomId,
      msgId,
      body: 'fixed typo',
    });
    expect(RoomDeleteMsgReq.parse({ roomId, msgId })).toMatchObject({ roomId, msgId });

    expect(() => RoomEditMsgReq.parse({ roomId, msgId, body: '' })).toThrow();
    expect(() => RoomDeleteMsgReq.parse({ roomId: 'not-a-room', msgId })).toThrow();
  });

  it('preserves edited and deleted room message metadata', () => {
    expect(RoomMessage.parse({
      id: msgId,
      roomId,
      channelId,
      fromPeerId: 'peer-12345678',
      ts: 123,
      body: 'hello',
      direction: 'out',
      editedAt: 456,
      deletedAt: 789,
    })).toMatchObject({
      id: msgId,
      editedAt: 456,
      deletedAt: 789,
      fromName: '',
    });
  });
});