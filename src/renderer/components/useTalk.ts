// Voice-call client: encapsulates microphone capture (MediaRecorder → opus
// chunks) and playback (MediaSource SourceBuffer fed by inbound chunks),
// plus tiny React hook to drive the IM window's call UI. Capture and
// playback each expose an AnalyserNode so the UI can draw a 00's-style
// waveform of mic / remote audio.
//
// Wire format is opaque WebM/Opus chunks; the main process just relays them.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScreenShareResolution, ScreenShareSource, TalkCallState } from '@shared/schemas';
import { playSound } from '../sounds/synth';
import { ScreenCaptureSink } from './useScreenCapture';

const MIME = 'audio/webm;codecs=opus';
const TIMESLICE_MS = 80;
// Early-2000s vibe video: 160x120 @ 10fps, 64 kbps VP8.
const VIDEO_MIME = 'video/webm;codecs=vp8';
// 100ms gives video chunks close in frequency to audio (80ms), cutting
// worst-case chunk latency from 250ms and reducing audio/video drift.
const VIDEO_TIMESLICE_MS = 100;
const VIDEO_BITS_PER_SEC = 64_000;
const VIDEO_WIDTH = 160;
const VIDEO_HEIGHT = 120;
const VIDEO_FPS = 10;

function createAudioContext(): AudioContext | null {
  try {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    return new Ctor();
  } catch {
    return null;
  }
}

class CaptureSink {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private muted = false;
  private ctx: AudioContext | null = null;
  private srcNode: MediaStreamAudioSourceNode | null = null;
  analyser: AnalyserNode | null = null;

  async start(send: (data: Uint8Array) => void): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.stream = stream;
    if (!('MediaRecorder' in window)) throw new Error('MediaRecorder not supported');
    if (!MediaRecorder.isTypeSupported(MIME)) throw new Error('Opus/WebM not supported');
    const rec = new MediaRecorder(stream, { mimeType: MIME });
    rec.ondataavailable = async (e) => {
      if (this.muted) return;
      if (e.data && e.data.size > 0) {
        try {
          const buf = new Uint8Array(await e.data.arrayBuffer());
          send(buf);
        } catch {
          /* ignore */
        }
      }
    };
    rec.start(TIMESLICE_MS);
    this.rec = rec;

    // Also wire the same MediaStream into a WebAudio analyser so we can draw
    // the outgoing waveform without re-decoding the recorder output.
    const ctx = createAudioContext();
    if (ctx) {
      try {
        if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        an.smoothingTimeConstant = 0.6;
        src.connect(an);
        // Don't connect to destination — mic monitoring would feed back.
        this.ctx = ctx;
        this.srcNode = src;
        this.analyser = an;
      } catch {
        /* ignore */
      }
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    // Also disable the mic track so the OS indicator can reflect it.
    if (this.stream) {
      for (const t of this.stream.getAudioTracks()) t.enabled = !m;
    }
  }

  stop(): void {
    try {
      if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    } catch {
      /* ignore */
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
    }
    if (this.srcNode) {
      try {
        this.srcNode.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
    }
    this.rec = null;
    this.stream = null;
    this.srcNode = null;
    this.analyser = null;
    this.ctx = null;
  }
}

class PlaybackSink {
  private audio: HTMLAudioElement | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: ArrayBuffer[] = [];
  private opened = false;
  private url: string | null = null;
  private ctx: AudioContext | null = null;
  private elNode: MediaElementAudioSourceNode | null = null;
  analyser: AnalyserNode | null = null;

  start(): void {
    // Idempotent: if we already set this up for the current call, do nothing.
    // (Calling stop() here would wipe the queue — including the very first
    // MediaRecorder chunk that carries the WebM/Opus init segment, after
    // which the SourceBuffer cannot decode anything.)
    if (this.audio) return;
    if (typeof MediaSource === 'undefined') return;
    if (!MediaSource.isTypeSupported(MIME)) return;
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.muted = false;
    audio.volume = 1.0;
    audio.controls = false;
    audio.style.display = 'none';
    const ms = new MediaSource();
    const url = URL.createObjectURL(ms);
    audio.src = url;
    document.body.appendChild(audio);
    // Kick playback synchronously — we're still inside the user-gesture frame
    // (Accept / Talk click) so Chromium's autoplay policy lets us through.
    void audio.play().catch((err) => console.warn('[talk] play() rejected (initial)', err));
    ms.addEventListener('sourceopen', () => {
      try {
        // Signal live-stream mode: suppress aggressive prefetch buffering.
        ms.duration = Infinity;
        const sb = ms.addSourceBuffer(MIME);
        // Sequence mode: ignore embedded WebM timestamps and assign them
        // monotonically, eliminating stalls from MediaRecorder clock drift.
        sb.mode = 'sequence';
        sb.addEventListener('updateend', () => this.drain());
        this.sourceBuffer = sb;
        this.opened = true;
        this.drain();
        void audio.play().catch((err) => console.warn('[talk] play() rejected (sourceopen)', err));
      } catch (err) {
        console.error('[talk] addSourceBuffer failed', err);
      }
    });
    this.audio = audio;
    this.mediaSource = ms;
    this.url = url;

    // Route through WebAudio so an analyser can tap the signal. Note: once
    // we create a MediaElementAudioSourceNode, the audio element's native
    // output is replaced by the AudioContext destination — we MUST connect
    // an->ctx.destination or playback is silent.
    const ctx = createAudioContext();
    if (ctx) {
      try {
        if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
        const src = ctx.createMediaElementSource(audio);
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        an.smoothingTimeConstant = 0.6;
        src.connect(an);
        an.connect(ctx.destination);
        this.ctx = ctx;
        this.elNode = src;
        this.analyser = an;
      } catch (err) {
        console.error('[talk] WebAudio routing failed', err);
      }
    }
  }

  push(data: Uint8Array): void {
    // Copy into a fresh ArrayBuffer so SourceBuffer's appendBuffer accepts it
    // (lib.dom requires ArrayBuffer-backed BufferSource).
    const buf = new ArrayBuffer(data.byteLength);
    new Uint8Array(buf).set(data);
    this.queue.push(buf);
    if (this.opened) this.drain();
  }

  private drain(): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating) return;
    const next = this.queue.shift();
    if (!next) return;
    try {
      sb.appendBuffer(next);
    } catch (err) {
      // Reset on quota / decode errors so we don't get stuck. Keep any later
      // queued chunks — the next MediaRecorder cluster is independently
      // decodable once the init segment is in.
      console.warn('[talk] appendBuffer failed', err);
    }
  }

  stop(): void {
    if (this.elNode) {
      try {
        this.elNode.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
    }
    if (this.audio) {
      try {
        this.audio.pause();
      } catch {
        /* ignore */
      }
      this.audio.remove();
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.audio = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = [];
    this.opened = false;
    this.url = null;
    this.ctx = null;
    this.elNode = null;
    this.analyser = null;
  }
}

// Low-bitrate video capture: getUserMedia → MediaRecorder VP8.
class VideoCaptureSink {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  stream$: MediaStream | null = null; // exposed to the local <video> tile

  async start(send: (data: Uint8Array) => void): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: VIDEO_WIDTH },
        height: { ideal: VIDEO_HEIGHT },
        frameRate: { ideal: VIDEO_FPS, max: VIDEO_FPS },
      },
    });
    this.stream = stream;
    this.stream$ = stream;
    if (!('MediaRecorder' in window)) throw new Error('MediaRecorder not supported');
    if (!MediaRecorder.isTypeSupported(VIDEO_MIME)) throw new Error('VP8/WebM not supported');
    const rec = new MediaRecorder(stream, {
      mimeType: VIDEO_MIME,
      videoBitsPerSecond: VIDEO_BITS_PER_SEC,
    });
    rec.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0) {
        try {
          const buf = new Uint8Array(await e.data.arrayBuffer());
          send(buf);
        } catch {
          /* ignore */
        }
      }
    };
    rec.start(VIDEO_TIMESLICE_MS);
    this.rec = rec;
  }

  stop(): void {
    try {
      if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    } catch {
      /* ignore */
    }
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.rec = null;
    this.stream = null;
    this.stream$ = null;
  }
}

// Receives VP8 chunks → MediaSource → <video> element. Same shape as PlaybackSink
// but no WebAudio analyser (we just display the raw video).
class VideoPlaybackSink {
  private video: HTMLVideoElement | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: ArrayBuffer[] = [];
  private opened = false;
  private url: string | null = null;
  videoEl: HTMLVideoElement | null = null;

  start(): void {
    if (this.video) return;
    if (typeof MediaSource === 'undefined') return;
    if (!MediaSource.isTypeSupported(VIDEO_MIME)) return;
    const v = document.createElement('video');
    v.autoplay = true;
    v.muted = true; // remote audio comes from the audio sink, not this element
    v.playsInline = true;
    v.controls = false;
    const ms = new MediaSource();
    const url = URL.createObjectURL(ms);
    v.src = url;
    void v.play().catch(() => undefined);
    ms.addEventListener('sourceopen', () => {
      try {
        // Signal live-stream mode: suppress aggressive prefetch buffering.
        ms.duration = Infinity;
        const sb = ms.addSourceBuffer(VIDEO_MIME);
        // Sequence mode: ignore embedded WebM timestamps, assign monotonically.
        sb.mode = 'sequence';
        sb.addEventListener('updateend', () => this.drain());
        this.sourceBuffer = sb;
        this.opened = true;
        this.drain();
        void v.play().catch(() => undefined);
      } catch (err) {
        console.error('[talk] video addSourceBuffer failed', err);
      }
    });
    this.video = v;
    this.videoEl = v;
    this.mediaSource = ms;
    this.url = url;
  }

  push(data: Uint8Array): void {
    const buf = new ArrayBuffer(data.byteLength);
    new Uint8Array(buf).set(data);
    this.queue.push(buf);
    if (this.opened) this.drain();
  }

  private drain(): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating) return;
    const v = this.video;
    // Trim buffered content more than 2s behind current playback position to
    // prevent unbounded buffer growth. remove() is async — updateend fires
    // again once done, re-invoking drain() to continue.
    if (v && v.buffered.length > 0) {
      const trimTo = v.currentTime - 2.0;
      if (trimTo > v.buffered.start(0)) {
        try {
          sb.remove(v.buffered.start(0), trimTo);
          return;
        } catch { /* ignore */ }
      }
    }
    const next = this.queue.shift();
    if (!next) {
      // Queue drained — nudge to live edge if currentTime has drifted > 500ms
      // behind the latest buffered data (e.g. after a stall or slow chunk).
      if (v && v.buffered.length > 0) {
        const edge = v.buffered.end(v.buffered.length - 1);
        if (edge - v.currentTime > 0.5) {
          v.currentTime = Math.max(0, edge - 0.1);
        }
      }
      return;
    }
    try {
      sb.appendBuffer(next);
    } catch (err) {
      console.warn('[talk] video appendBuffer failed', err);
    }
  }

  stop(): void {
    if (this.video) {
      try { this.video.pause(); } catch { /* ignore */ }
      this.video.removeAttribute('src');
      try { this.video.load(); } catch { /* ignore */ }
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.video = null;
    this.videoEl = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = [];
    this.opened = false;
    this.url = null;
  }
}

export type CallUi = {
  call: TalkCallState | null;
  muted: boolean;
  videoOn: boolean;
  remoteVideoOn: boolean;
  screenOn: boolean;
  remoteScreenOn: boolean;
  remoteScreenLabel: string;
  error: string;
  elapsedSec: number;
  // Live AudioWorklet-style analysers — may be null when no call is active.
  // Returned via getters so the WaveformCanvas can poll the latest reference
  // each animation frame (sinks recreate them on start/stop).
  getMicAnalyser: () => AnalyserNode | null;
  getRemoteAnalyser: () => AnalyserNode | null;
  // Live MediaStream / video element references for the UI tiles.
  getLocalVideoStream: () => MediaStream | null;
  getRemoteVideoEl: () => HTMLVideoElement | null;
  getLocalScreenStream: () => MediaStream | null;
  getRemoteScreenEl: () => HTMLVideoElement | null;
  startCall: (kind?: 'voice' | 'video') => Promise<void>;
  acceptIncoming: () => Promise<void>;
  rejectIncoming: () => Promise<void>;
  endCall: () => Promise<void>;
  toggleMute: () => void;
  toggleVideo: () => Promise<void>;
  startScreenShare: (source: ScreenShareSource, resolution: ScreenShareResolution) => Promise<void>;
  stopScreenShare: () => Promise<void>;
};

// Hook bound to a single peer. The main process tracks at most one global call
// at a time, so this hook only fires for events whose peerId matches.
// Pass `opts.kind` to ignore calls of the other kind — e.g. the IM window
// passes 'voice' so the dedicated VideoCall window owns video calls.
export function useTalk(
  peerId: string,
  opts: { kind?: 'voice' | 'video' } = {},
): CallUi {
  const filterKind = opts.kind;
  const matchKind = (s: TalkCallState | null): boolean => {
    if (!s) return false;
    if (!filterKind) return true;
    return (s.kind ?? 'voice') === filterKind;
  };
  const [call, setCall] = useState<TalkCallState | null>(null);
  const [muted, setMuted] = useState(false);
  const [videoOn, setVideoOn] = useState(false);
  const [remoteVideoOn, setRemoteVideoOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [remoteScreenOn, setRemoteScreenOn] = useState(false);
  const [remoteScreenLabel, setRemoteScreenLabel] = useState('');
  const [error, setError] = useState('');
  const [elapsedSec, setElapsedSec] = useState(0);
  const capture = useMemo(() => new CaptureSink(), []);
  const playback = useMemo(() => new PlaybackSink(), []);
  const videoCapture = useMemo(() => new VideoCaptureSink(), []);
  const videoPlayback = useMemo(() => new VideoPlaybackSink(), []);
  const screenCapture = useMemo(() => new ScreenCaptureSink(), []);
  const screenPlayback = useMemo(() => new VideoPlaybackSink(), []);
  const ringTimer = useRef<number | null>(null);

  // On mount, sync any in-progress call state for this peer.
  useEffect(() => {
    let cancelled = false;
    void window.buzz
      .talkGetActive(peerId)
      .then((s) => {
        if (cancelled) return;
        if (s && s.peerId === peerId && s.state !== 'ended' && matchKind(s)) setCall(s);
      })
      .catch(() => undefined);

    const offInvite = window.buzz.onTalkInvite((e) => {
      if (e.peerId !== peerId) return;
      if (!matchKind(e)) return;
      setCall(e);
    });
    const offState = window.buzz.onTalkState((e) => {
      if (e.peerId !== peerId) return;
      if (!matchKind(e)) return;
      setCall(e.state === 'ended' ? null : e);
    });
    const offEnded = window.buzz.onTalkEnded((e) => {
      if (e.peerId !== peerId) return;
      setCall(null);
      setError(e.reason ? `Call ended: ${e.reason}` : '');
    });
    const offAudio = window.buzz.onTalkAudio((e) => {
      if (e.peerId !== peerId) return;
      playback.push(e.data);
    });
    const offVideo = window.buzz.onTalkVideo((e) => {
      if (e.peerId !== peerId) return;
      videoPlayback.push(e.data);
    });
    const offVideoState = window.buzz.onTalkVideoState((e) => {
      if (e.peerId !== peerId) return;
      setRemoteVideoOn(e.on);
      // Reset the playback sink between toggles so the next 'on' starts with
      // a fresh init segment from the remote MediaRecorder.
      if (!e.on) videoPlayback.stop();
      else videoPlayback.start();
    });
    const offScreen = window.buzz.onTalkScreen((e) => {
      if (e.peerId !== peerId) return;
      screenPlayback.push(e.data);
    });
    const offScreenState = window.buzz.onTalkScreenState((e) => {
      if (e.peerId !== peerId) return;
      setRemoteScreenOn(e.on);
      setRemoteScreenLabel(e.on ? [e.sourceName, e.resolution].filter(Boolean).join(' • ') : '');
      if (!e.on) screenPlayback.stop();
      else screenPlayback.start();
    });

    return () => {
      cancelled = true;
      offInvite();
      offState();
      offEnded();
      offAudio();
      offVideo();
      offVideoState();
      offScreen();
      offScreenState();
      capture.stop();
      playback.stop();
      videoCapture.stop();
      videoPlayback.stop();
      screenCapture.stop();
      screenPlayback.stop();
      if (ringTimer.current !== null) {
        window.clearInterval(ringTimer.current);
        ringTimer.current = null;
      }
    };
  }, [peerId, capture, playback, videoCapture, videoPlayback, screenCapture, screenPlayback]);

  // Drive ringing sound on the callee side.
  useEffect(() => {
    if (call?.state === 'ringing' && call.role === 'callee') {
      playSound('ring');
      const id = window.setInterval(() => playSound('ring'), 1200);
      ringTimer.current = id;
      return () => {
        window.clearInterval(id);
        if (ringTimer.current === id) ringTimer.current = null;
      };
    }
    return undefined;
  }, [call?.state, call?.role]);

  // Start audio capture + playback once active.
  useEffect(() => {
    if (call?.state !== 'active') {
      capture.stop();
      playback.stop();
      videoCapture.stop();
      videoPlayback.stop();
      screenCapture.stop();
      screenPlayback.stop();
      setVideoOn(false);
      setRemoteVideoOn(false);
      setScreenOn(false);
      setRemoteScreenOn(false);
      setRemoteScreenLabel('');
      return;
    }
    playback.start();
    let cancelled = false;
    void capture
      .start(async (data) => {
        if (cancelled) return;
        // Fire-and-forget; preload sends via ipcRenderer.send so this is
        // already non-blocking, but the synchronous call signature lets the
        // MediaRecorder callback return immediately.
        void window.buzz.talkSendAudio(call.callId, data).catch(() => undefined);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Microphone unavailable');
        void window.buzz.talkEnd(call.callId).catch(() => undefined);
      });
    // For video calls, auto-enable the camera as soon as the call is active.
    if ((call.kind ?? 'voice') === 'video' && !videoOn) {
      void (async () => {
        try {
          await videoCapture.start((data) => {
            void window.buzz.talkSendVideo(call.callId, data).catch(() => undefined);
          });
          if (!cancelled) {
            setVideoOn(true);
            await window.buzz.talkSetVideo(call.callId, true).catch(() => undefined);
          } else {
            videoCapture.stop();
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Camera unavailable');
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [call?.state, call?.callId, call?.kind, capture, playback, videoCapture, videoPlayback, screenCapture, screenPlayback]);

  // Apply mute changes to the live capture.
  useEffect(() => {
    capture.setMuted(muted);
  }, [muted, capture]);

  // Tick a counter while active.
  useEffect(() => {
    if (call?.state !== 'active' || !call.startedAt) {
      setElapsedSec(0);
      return undefined;
    }
    const tick = () => setElapsedSec(Math.max(0, Math.floor((Date.now() - (call.startedAt ?? 0)) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [call?.state, call?.startedAt]);

  return {
    call,
    muted,
    videoOn,
    remoteVideoOn,
    screenOn,
    remoteScreenOn,
    remoteScreenLabel,
    error,
    elapsedSec,
    getMicAnalyser: () => capture.analyser,
    getRemoteAnalyser: () => playback.analyser,
    getLocalVideoStream: () => videoCapture.stream$,
    getRemoteVideoEl: () => videoPlayback.videoEl,
    getLocalScreenStream: () => screenCapture.stream$,
    getRemoteScreenEl: () => screenPlayback.videoEl,
    startCall: async (kind: 'voice' | 'video' = 'voice') => {
      setError('');
      // Prime the playback element NOW while we still have a user gesture,
      // so Chromium's autoplay policy lets audio.play() through later.
      try {
        playback.start();
      } catch {
        /* ignore */
      }
      try {
        await window.buzz.talkInvite(peerId, kind);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to start call');
      }
    },
    acceptIncoming: async () => {
      setError('');
      if (!call) return;
      // Prime the playback element NOW while we still have a user gesture.
      try {
        playback.start();
      } catch {
        /* ignore */
      }
      try {
        await window.buzz.talkAccept(call.callId);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to accept');
      }
    },
    rejectIncoming: async () => {
      if (!call) return;
      try {
        await window.buzz.talkReject(call.callId);
      } catch {
        /* ignore */
      }
    },
    endCall: async () => {
      if (!call) return;
      try {
        await window.buzz.talkEnd(call.callId);
      } catch {
        /* ignore */
      }
    },
    toggleMute: () => setMuted((m) => !m),
    toggleVideo: async () => {
      if (!call || call.state !== 'active') return;
      if (videoOn) {
        videoCapture.stop();
        setVideoOn(false);
        await window.buzz.talkSetVideo(call.callId, false).catch(() => undefined);
        return;
      }
      try {
        await videoCapture.start((data) => {
          void window.buzz.talkSendVideo(call.callId, data).catch(() => undefined);
        });
        setVideoOn(true);
        await window.buzz.talkSetVideo(call.callId, true).catch(() => undefined);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Camera unavailable');
        videoCapture.stop();
        setVideoOn(false);
      }
    },
    startScreenShare: async (source: ScreenShareSource, resolution: ScreenShareResolution) => {
      if (!call || call.state !== 'active') return;
      try {
        await screenCapture.start(
          source,
          resolution,
          (data) => {
            void window.buzz.talkSendScreen(call.callId, data).catch(() => undefined);
          },
          () => {
            setScreenOn(false);
            void window.buzz.talkSetScreen(call.callId, false).catch(() => undefined);
          },
        );
        setScreenOn(true);
        await window.buzz.talkSetScreen(call.callId, true, source.name, resolution).catch(() => undefined);
      } catch (e) {
        screenCapture.stop();
        setScreenOn(false);
        setError(e instanceof Error ? e.message : 'Screen sharing unavailable');
      }
    },
    stopScreenShare: async () => {
      screenCapture.stop();
      setScreenOn(false);
      if (call?.state === 'active') {
        await window.buzz.talkSetScreen(call.callId, false).catch(() => undefined);
      }
    },
  };
}

export function fmtCallTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
