// Dedicated video chat window. One peer per window. Drives the
// useTalk hook in 'video' mode, which auto-enables the camera once
// the call goes active. Supports incoming and outgoing.

import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyPlatformTheme } from '../../theme/applyPlatform';
import { WindowChrome } from '../../components/WindowChrome';
import { CallVideoLocal, CallVideoRemote } from '../../components/CallVideo';
import { WaveformCanvas } from '../../components/WaveformCanvas';
import { useTalk, fmtCallTime } from '../../components/useTalk';

function getPeerIdFromHash(): string {
  return decodeURIComponent(window.location.hash.replace(/^#/, '')).trim();
}

function App(): JSX.Element {
  const peerId = getPeerIdFromHash();
  const [alias, setAlias] = useState<string>(peerId.slice(0, 12) + '…');
  const talk = useTalk(peerId, { kind: 'video' });

  useEffect(() => {
    void applyPlatformTheme(window.buzz);
    void window.buzz.listBuddies().then((bs) => {
      const b = bs.find((x) => x.peerId === peerId);
      if (b) setAlias(b.alias);
    });
  }, [peerId]);

  // Close the window when the call ends.
  useEffect(() => {
    if (!talk.call) {
      const t = window.setTimeout(() => void window.buzzWindows.close(), 1200);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [talk.call]);

  // If the user closes/reloads the window mid-call, hang up so the peer is
  // notified instead of being left listening to a dead stream.
  const callIdRef = useRef<string | null>(null);
  useEffect(() => {
    callIdRef.current = talk.call ? talk.call.callId : null;
  }, [talk.call]);
  useEffect(() => {
    const onUnload = (): void => {
      const id = callIdRef.current;
      if (id) {
        // Fire-and-forget; the IPC message is queued before the renderer dies.
        void window.buzz.talkEnd(id).catch(() => undefined);
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  const ringing = talk.call?.state === 'ringing' && talk.call.role === 'callee';
  const inviting = talk.call?.state === 'inviting';
  const active = talk.call?.state === 'active';

  return (
    <div className="aim-window vc-window">
      <WindowChrome title={`Video Chat — ${alias}`} />
      <div className="vc-body">
        <div className="vc-stage">
          {active && talk.remoteVideoOn ? (
            <CallVideoRemote getEl={talk.getRemoteVideoEl} />
          ) : (
            <div className="vc-stage-placeholder">
              {ringing && <span><b>{talk.call?.screenName || alias}</b> wants to video chat.</span>}
              {inviting && <span>Calling {alias}…</span>}
              {active && !talk.remoteVideoOn && <span>Waiting for {alias}'s camera…</span>}
              {!talk.call && <span>Call ended.</span>}
            </div>
          )}
          {active && talk.videoOn && (
            <div className="vc-self">
              <CallVideoLocal getStream={talk.getLocalVideoStream} />
            </div>
          )}
        </div>
        {active && (
          <div className="vc-waves">
            <div className="vc-wave-pair">
              <span className="vc-wave-label">You</span>
              <WaveformCanvas
                getAnalyser={talk.getMicAnalyser}
                color={talk.muted ? '#5a5a5a' : '#33ff66'}
                bg="#001a05"
                active={!talk.muted}
              />
            </div>
            <div className="vc-wave-pair">
              <span className="vc-wave-label">Them</span>
              <WaveformCanvas
                getAnalyser={talk.getRemoteAnalyser}
                color="#ff3399"
                bg="#1a0010"
              />
            </div>
          </div>
        )}
        <div className="vc-controls">
          {ringing && (
            <>
              <button onClick={() => void talk.acceptIncoming()}>Accept</button>{' '}
              <button onClick={() => void talk.rejectIncoming()}>Decline</button>
            </>
          )}
          {(inviting || active) && (
            <>
              {active && (
                <>
                  <span className="vc-status">{fmtCallTime(talk.elapsedSec)}</span>
                  <button onClick={() => talk.toggleMute()}>{talk.muted ? 'Unmute' : 'Mute'}</button>
                  <button onClick={() => void talk.toggleVideo()}>
                    {talk.videoOn ? 'Camera Off' : 'Camera On'}
                  </button>
                </>
              )}
              <button onClick={() => void talk.endCall()}>End</button>
            </>
          )}
        </div>
        {talk.error && <div className="error" style={{ margin: '4px 8px' }}>{talk.error}</div>}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
