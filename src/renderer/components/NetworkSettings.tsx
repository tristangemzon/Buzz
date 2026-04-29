import React, { useEffect, useState } from 'react';
import type { NetworkConfig } from '@shared/schemas';

type Props = {
  onClose(): void;
};

export function NetworkSettings({ onClose }: Props): JSX.Element {
  const [mode, setMode] = useState<'p2p' | 'server'>('p2p');
  const [serverAddr, setServerAddr] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    window.buzz
      .getNetworkConfig()
      .then((cfg) => {
        setMode(cfg.mode);
        setServerAddr(cfg.serverAddr ?? '');
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  async function save(): Promise<void> {
    setErr('');
    setBusy(true);
    try {
      const cfg: NetworkConfig = { mode, serverAddr: mode === 'server' ? serverAddr.trim() : '' };
      await window.buzz.setNetworkConfig(cfg);
      onClose();
    } catch (e) {
      // zod errors come back as a stringified message via IPC.
      const msg = e instanceof Error ? e.message : 'Failed to save.';
      // Try to extract the friendly bit from a zod error string.
      const match = msg.match(/Must be a multiaddr ending in \/p2p\/<peerid>/);
      setErr(match ? match[0] : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Network Settings</div>
        <div className="modal-body">
          {!loaded ? (
            <div className="muted">Loading…</div>
          ) : (
            <>
              <div className="row">
                <label className="radio">
                  <input
                    type="radio"
                    name="netmode"
                    checked={mode === 'p2p'}
                    onChange={() => setMode('p2p')}
                  />
                  <span>
                    <strong>P2P</strong> — public DHT (default)
                  </span>
                </label>
                <div className="muted small">
                  Discover peers via the public libp2p bootstrap nodes. Direct connections when
                  reachable, circuit-relay when not. End-to-end encrypted via Noise XX.
                </div>
              </div>

              <div className="row">
                <label className="radio">
                  <input
                    type="radio"
                    name="netmode"
                    checked={mode === 'server'}
                    onChange={() => setMode('server')}
                  />
                  <span>
                    <strong>Server</strong> — connect to a Buzz server
                  </span>
                </label>
                <div className="muted small">
                  Use a specific Buzz server as bootstrap and offline mailbox relay. Still
                  end-to-end encrypted; the server cannot read your messages.
                </div>
                {mode === 'server' && (
                  <div className="row indent">
                    <label className="label">Server address (multiaddr)</label>
                    <input
                      className="bevel-in"
                      value={serverAddr}
                      onChange={(e) => setServerAddr(e.target.value)}
                      placeholder="/dns4/buzz.example.com/tcp/4001/p2p/12D3KooW..."
                      spellCheck={false}
                      autoFocus
                    />
                  </div>
                )}
              </div>

              <div className="error">{err}</div>
            </>
          )}
        </div>
        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button onClick={save} disabled={busy || !loaded}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
