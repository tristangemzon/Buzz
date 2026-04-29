// 00's-style oscilloscope-ish waveform driven by an AnalyserNode.
// Pulls latest time-domain samples each animation frame and draws a centered
// scrolling line. Pure decoration — fails silent if no analyser is attached.

import React, { useEffect, useRef } from 'react';

export function WaveformCanvas(props: {
  getAnalyser: () => AnalyserNode | null;
  color?: string;
  bg?: string;
  height?: number;
  width?: number;
  active?: boolean;
}): JSX.Element {
  const { getAnalyser, color = '#33ff66', bg = '#001a05', height = 22, width = 90, active = true } = props;
  const ref = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const dataRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.scale(dpr, dpr);

    let stopped = false;
    const draw = (): void => {
      if (stopped) return;
      const an = getAnalyser();
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      // Center reference line.
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();

      if (an && active) {
        const n = an.fftSize;
        let buf = dataRef.current;
        if (!buf || buf.length !== n) {
          buf = new Uint8Array(new ArrayBuffer(n));
          dataRef.current = buf;
        }
        an.getByteTimeDomainData(buf as Uint8Array<ArrayBuffer>);

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        const step = n / width;
        for (let x = 0; x < width; x++) {
          const i = Math.floor(x * step);
          // 128 = silence, 0..255 spans -1..+1
          const v = ((buf[i] ?? 128) - 128) / 128;
          const y = height / 2 + v * (height / 2 - 2);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Soft glow.
        ctx.shadowColor = color;
        ctx.shadowBlur = 4;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      rafRef.current = window.requestAnimationFrame(draw);
    };
    draw();

    return () => {
      stopped = true;
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [getAnalyser, color, bg, height, width, active]);

  return (
    <canvas
      ref={ref}
      className="waveform"
      style={{ width, height, display: 'block' }}
    />
  );
}
