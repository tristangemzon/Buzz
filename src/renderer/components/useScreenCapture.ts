import type { ScreenShareResolution, ScreenShareSource } from '@shared/schemas';

const SCREEN_MIME = 'video/webm;codecs=vp8';
const SCREEN_TIMESLICE_MS = 200;

export const SCREEN_RESOLUTION_PRESETS: Record<ScreenShareResolution, { label: string; maxWidth: number; maxHeight: number; fps: number; bitrate: number }> = {
  '480p': { label: '480p', maxWidth: 854, maxHeight: 480, fps: 8, bitrate: 384_000 },
  '720p': { label: '720p', maxWidth: 1280, maxHeight: 720, fps: 8, bitrate: 768_000 },
  '1080p': { label: '1080p', maxWidth: 1920, maxHeight: 1080, fps: 10, bitrate: 1_400_000 },
};

export function fitWithinBounds(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const scale = Math.min(1, maxWidth / safeWidth, maxHeight / safeHeight);
  const fittedWidth = Math.max(2, Math.floor((safeWidth * scale) / 2) * 2);
  const fittedHeight = Math.max(2, Math.floor((safeHeight * scale) / 2) * 2);
  return { width: fittedWidth, height: fittedHeight };
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Screen capture did not start'));
    }, 5_000);
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    };
    const onLoaded = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error('Screen capture failed'));
    };
    video.addEventListener('loadedmetadata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

export class ScreenCaptureSink {
  private sourceStream: MediaStream | null = null;
  private outputStream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private video: HTMLVideoElement | null = null;
  private drawTimer: number | null = null;
  private ended = false;
  stream$: MediaStream | null = null;

  async start(
    source: ScreenShareSource,
    resolution: ScreenShareResolution,
    send: (data: Uint8Array) => void | Promise<void>,
    onEnded: () => void,
  ): Promise<void> {
    this.stop();
    this.ended = false;
    try {
      const preset = SCREEN_RESOLUTION_PRESETS[resolution];
      const captureConstraints = {
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id,
            maxFrameRate: preset.fps,
          },
        },
      } as unknown as MediaStreamConstraints;

      const sourceStream = await navigator.mediaDevices.getUserMedia(captureConstraints);
      this.sourceStream = sourceStream;

      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = sourceStream;
      this.video = video;
      await video.play().catch(() => undefined);
      await waitForMetadata(video);

      const track = sourceStream.getVideoTracks()[0];
      const settings = track?.getSettings();
      const sourceWidth = settings?.width ?? video.videoWidth;
      const sourceHeight = settings?.height ?? video.videoHeight;
      const fitted = fitWithinBounds(sourceWidth, sourceHeight, preset.maxWidth, preset.maxHeight);

      const canvas = document.createElement('canvas');
      canvas.width = fitted.width;
      canvas.height = fitted.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Screen capture canvas unavailable');
      this.canvas = canvas;

      const draw = (): void => {
        if (this.ended) return;
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        } catch {
          /* ignore transient capture blanks */
        }
      };
      draw();
      this.drawTimer = window.setInterval(draw, Math.max(50, Math.round(1000 / preset.fps)));

      const outputStream = canvas.captureStream(preset.fps);
      this.outputStream = outputStream;
      this.stream$ = outputStream;
      track?.addEventListener('ended', () => {
        if (this.ended) return;
        this.stop();
        onEnded();
      }, { once: true });

      if (!('MediaRecorder' in window)) throw new Error('MediaRecorder not supported');
      if (!MediaRecorder.isTypeSupported(SCREEN_MIME)) throw new Error('VP8/WebM not supported');
      const rec = new MediaRecorder(outputStream, {
        mimeType: SCREEN_MIME,
        videoBitsPerSecond: preset.bitrate,
      });
      rec.ondataavailable = async (e) => {
        if (e.data && e.data.size > 0) {
          try {
            await send(new Uint8Array(await e.data.arrayBuffer()));
          } catch {
            /* peer disconnected */
          }
        }
      };
      rec.start(SCREEN_TIMESLICE_MS);
      this.rec = rec;
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  stop(): void {
    this.ended = true;
    if (this.drawTimer !== null) {
      window.clearInterval(this.drawTimer);
      this.drawTimer = null;
    }
    try {
      if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    } catch {
      /* ignore */
    }
    if (this.sourceStream) for (const t of this.sourceStream.getTracks()) t.stop();
    if (this.outputStream) for (const t of this.outputStream.getTracks()) t.stop();
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
    }
    this.rec = null;
    this.sourceStream = null;
    this.outputStream = null;
    this.stream$ = null;
    this.canvas = null;
    this.video = null;
  }
}