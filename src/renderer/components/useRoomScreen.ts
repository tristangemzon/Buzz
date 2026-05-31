// Room-voice-channel screen share hook. Models a single active presenter at a
// time per (roomId, channelId). Inbound presenter video is rendered into the
// caller-supplied <video> element via a MediaSource sink.
//
// Transport: chunks are VP8/WebM frames sent via window.buzz.roomScreenSendVideo
// (which secret-boxes them with the room key and fans them out to every member
// over the existing IM channel — same trust model as room-voice-audio).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScreenShareResolution, ScreenShareSource } from '@shared/schemas';
import { ScreenCaptureSink } from './useScreenCapture';

const SCREEN_MIME = 'video/webm;codecs=vp8';

class ScreenPlaybackSink {
  readonly video: HTMLVideoElement;
  private ms: MediaSource;
  private buf: SourceBuffer | null = null;
  private queue: Uint8Array[] = [];
  private alive = true;

  constructor() {
    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;
    this.ms = new MediaSource();
    this.video.src = URL.createObjectURL(this.ms);
    this.ms.addEventListener('sourceopen', () => {
      if (!this.alive) return;
      try {
        const sb = this.ms.addSourceBuffer(SCREEN_MIME);
        sb.mode = 'sequence';
        sb.addEventListener('updateend', () => this.flush());
        this.buf = sb;
        this.flush();
      } catch {
        /* ignore */
      }
    });
    void this.video.play().catch(() => undefined);
  }

  push(data: Uint8Array): void {
    this.queue.push(data);
    this.flush();
  }

  private flush(): void {
    if (!this.alive || !this.buf || this.buf.updating) return;
    const next = this.queue.shift();
    if (!next) return;
    try {
      const copy = new Uint8Array(new ArrayBuffer(next.byteLength));
      copy.set(next);
      this.buf.appendBuffer(copy);
    } catch {
      this.queue = [];
    }
  }

  dispose(): void {
    this.alive = false;
    try {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    } catch {
      /* ignore */
    }
  }
}

export type RoomScreenPresenter = {
  peerId: string;
  screenName: string;
  sourceName?: string;
  resolution?: ScreenShareResolution;
};

export type RoomScreenUi = {
  presenter: RoomScreenPresenter | null;
  iAmPresenting: boolean;
  videoEl: HTMLVideoElement | null;
  error: string | null;
  startShare: (source: ScreenShareSource, resolution: ScreenShareResolution) => Promise<void>;
  stopShare: () => Promise<void>;
};

export function useRoomScreen(
  roomId: string,
  channelId: string | null,
  joined: boolean,
  myPeerId: string | null,
): RoomScreenUi {
  const [presenter, setPresenter] = useState<RoomScreenPresenter | null>(null);
  const [iAmPresenting, setIAmPresenting] = useState(false);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const captureRef = useRef<ScreenCaptureSink | null>(null);
  const sinkRef = useRef<ScreenPlaybackSink | null>(null);
  const channelRef = useRef<string | null>(null);
  channelRef.current = channelId;
  const presenterPeerRef = useRef<string | null>(null);
  presenterPeerRef.current = presenter?.peerId ?? null;

  // Presenter state changes.
  useEffect(() => {
    const off = window.buzz.onRoomScreenState((e) => {
      if (e.roomId !== roomId || e.channelId !== channelRef.current) return;
      if (e.presenting) {
        // Only show inbound presenters (ours is tracked via iAmPresenting).
        if (e.peerId === myPeerId) return;
        setPresenter({
          peerId: e.peerId,
          screenName: e.screenName,
          sourceName: e.sourceName,
          resolution: e.resolution as ScreenShareResolution | undefined,
        });
        // Fresh sink for the new stream.
        sinkRef.current?.dispose();
        const sink = new ScreenPlaybackSink();
        sinkRef.current = sink;
        setVideoEl(sink.video);
      } else {
        if (presenterPeerRef.current === e.peerId) {
          setPresenter(null);
          sinkRef.current?.dispose();
          sinkRef.current = null;
          setVideoEl(null);
        }
      }
    });
    return () => off();
  }, [roomId, myPeerId]);

  // Inbound video chunks.
  useEffect(() => {
    const off = window.buzz.onRoomScreenVideo((e) => {
      if (e.roomId !== roomId || e.channelId !== channelRef.current) return;
      const sink = sinkRef.current;
      if (!sink) return;
      if (presenterPeerRef.current && e.peerId !== presenterPeerRef.current) return;
      sink.push(e.data);
    });
    return () => off();
  }, [roomId]);

  // Tear down everything when we leave the voice channel or unmount.
  useEffect(() => {
    return () => {
      const cap = captureRef.current;
      captureRef.current = null;
      if (cap) cap.stop();
      sinkRef.current?.dispose();
      sinkRef.current = null;
      if (iAmPresenting && channelRef.current) {
        void window.buzz
          .roomScreenStop({ roomId, channelId: channelRef.current })
          .catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, channelId]);

  // If we leave the voice channel while presenting, stop locally.
  useEffect(() => {
    if (joined) return;
    setPresenter(null);
    setIAmPresenting(false);
    sinkRef.current?.dispose();
    sinkRef.current = null;
    setVideoEl(null);
    const cap = captureRef.current;
    captureRef.current = null;
    if (cap) cap.stop();
  }, [joined]);

  const startShare = useCallback(
    async (source: ScreenShareSource, resolution: ScreenShareResolution): Promise<void> => {
      if (!channelId) return;
      if (!joined) {
        setError('Join the voice channel first.');
        return;
      }
      if (presenter && presenter.peerId !== myPeerId) {
        setError(`${presenter.screenName || 'Someone'} is already presenting.`);
        return;
      }
      setError(null);
      try {
        await window.buzz.roomScreenStart({
          roomId,
          channelId,
          sourceName: source.name,
          resolution,
        });
        const cap = new ScreenCaptureSink();
        await cap.start(
          source,
          resolution,
          (data) => {
            void window.buzz.roomScreenSendVideo({ roomId, channelId }, data);
          },
          () => {
            // Source ended (e.g. user clicked browser's stop-sharing chrome).
            setIAmPresenting(false);
            void window.buzz
              .roomScreenStop({ roomId, channelId })
              .catch(() => undefined);
          },
        );
        captureRef.current = cap;
        setIAmPresenting(true);
      } catch (e) {
        setError(String((e as Error).message ?? e));
        captureRef.current?.stop();
        captureRef.current = null;
        await window.buzz
          .roomScreenStop({ roomId, channelId })
          .catch(() => undefined);
      }
    },
    [roomId, channelId, joined, presenter, myPeerId],
  );

  const stopShare = useCallback(async (): Promise<void> => {
    if (!channelId) return;
    const cap = captureRef.current;
    captureRef.current = null;
    if (cap) cap.stop();
    setIAmPresenting(false);
    await window.buzz
      .roomScreenStop({ roomId, channelId })
      .catch(() => undefined);
  }, [roomId, channelId]);

  return { presenter, iAmPresenting, videoEl, error, startShare, stopShare };
}
