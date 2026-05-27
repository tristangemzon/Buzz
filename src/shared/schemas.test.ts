import { describe, expect, it } from 'vitest';
import { fitWithinBounds } from '@renderer/components/useScreenCapture';
import { ConnectionHealth, HistoryReq, Profile, RoomDeleteMsgReq, RoomEditMsgReq, RoomHistoryReq, RoomMessage, RoomSendReq, ScreenName, ScreenShareSource, TalkScreenEvent, TalkScreenStateReq } from './schemas.js';

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

  it('validates connection health snapshots', () => {
    expect(ConnectionHealth.parse({
      mode: 'server',
      locked: false,
      summary: 'online',
      updatedAt: 1000,
      p2p: { state: 'offline', label: 'P2P offline' },
      hive: { state: 'online', label: 'Hive connected', detail: 'wss://hive.local', lastOkAt: 900 },
      mesh: { state: 'offline', label: 'Mesh off' },
      mailbox: { state: 'offline', label: 'Hive handles offline delivery' },
      call: { state: 'offline', label: 'No active call' },
      roomVoice: { state: 'offline', label: 'No room voice' },
    })).toMatchObject({
      mode: 'server',
      summary: 'online',
      hive: { label: 'Hive connected' },
    });

    expect(() => ConnectionHealth.parse({
      mode: 'server',
      locked: false,
      summary: 'maybe',
      updatedAt: 1000,
    })).toThrow();
  });

  it('validates screenshare contracts', () => {
    expect(ScreenShareSource.parse({
      id: 'screen:1:0',
      name: 'Built-in Display',
      kind: 'screen',
      thumbnailDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    })).toMatchObject({ kind: 'screen' });

    expect(TalkScreenStateReq.parse({
      callId: msgId,
      on: true,
      sourceName: 'Code Window',
      resolution: '1080p',
    })).toMatchObject({ on: true, resolution: '1080p' });

    const data = new Uint8Array([1, 2, 3]);
    expect(TalkScreenEvent.parse({
      callId: msgId,
      peerId: 'peer-12345678',
      seq: 0,
      data,
    })).toMatchObject({ data });

    expect(() => ScreenShareSource.parse({ id: '', name: 'x', kind: 'screen' })).toThrow();
    expect(() => TalkScreenStateReq.parse({ callId: msgId, on: true, resolution: '4k' })).toThrow();
  });

  it('caps screenshare dimensions without upscaling', () => {
    expect(fitWithinBounds(3840, 2160, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(fitWithinBounds(2560, 1080, 1920, 1080)).toEqual({ width: 1920, height: 810 });
    expect(fitWithinBounds(1280, 720, 1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(fitWithinBounds(1080, 1920, 1920, 1080)).toEqual({ width: 606, height: 1080 });
  });
});