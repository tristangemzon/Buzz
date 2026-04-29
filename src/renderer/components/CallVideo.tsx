// Local-camera <video> tile. Polls the capture sink each render for the latest
// MediaStream and binds it to a hidden <video>. Mirrored for natural webcam feel.
import React from 'react';

export function CallVideoLocal(props: { getStream: () => MediaStream | null }): JSX.Element {
  const ref = React.useRef<HTMLVideoElement>(null);
  React.useEffect(() => {
    let stopped = false;
    const tick = (): void => {
      if (stopped) return;
      const v = ref.current;
      const s = props.getStream();
      if (v && s && v.srcObject !== s) {
        v.srcObject = s;
        void v.play().catch(() => undefined);
      }
      requestAnimationFrame(tick);
    };
    tick();
    return () => {
      stopped = true;
    };
  }, [props]);
  return <video ref={ref} className="call-video" autoPlay muted playsInline />;
}

// Remote video tile. The MediaSource-driven <video> already exists in the
// VideoPlaybackSink; we pluck it and reparent it into our tile.
export function CallVideoRemote(props: { getEl: () => HTMLVideoElement | null }): JSX.Element {
  const hostRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    let stopped = false;
    const tick = (): void => {
      if (stopped) return;
      const host = hostRef.current;
      const el = props.getEl();
      if (host && el && el.parentElement !== host) {
        el.classList.add('call-video');
        el.muted = true;
        host.appendChild(el);
      }
      requestAnimationFrame(tick);
    };
    tick();
    return () => {
      stopped = true;
    };
  }, [props]);
  return <div ref={hostRef} className="call-video-host" />;
}
