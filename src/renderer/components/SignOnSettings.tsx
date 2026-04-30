import React, { useEffect, useState } from 'react';
import type { NetworkConfig } from '@shared/schemas';

type Props = {
  // Notified after a successful factory reset so the host (SignOn) can
  // refresh its profile list and snap back to the create-account flow.
  onReset?(): void;
  onClose(): void;
};

type Section = 'network' | 'reset';

// Pre-login settings dialog. Replaces the old single-purpose NetworkSettings
// modal with a sectioned layout so we can host several knobs (currently:
// network mode + factory reset). Stays fully usable while the session is
// locked — no IPC here requires an unlocked DB.
export function SignOnSettings({ onClose, onReset }: Props): JSX.Element {
  const [section, setSection] = useState<Section>('network');

  // Network mode state.
  const [mode, setMode] = useState<'p2p' | 'server'>('p2p');
  const [serverUrl, setServerUrl] = useState('');
  const [serverCacheEnabled, setServerCacheEnabled] = useState(true);
  const [netErr, setNetErr] = useState('');
  const [netBusy, setNetBusy] = useState(false);
  const [netLoaded, setNetLoaded] = useState(false);

  // Reset state.
  const [confirmText, setConfirmText] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const [resetErr, setResetErr] = useState('');

  useEffect(() => {
    window.buzz
      .getNetworkConfig()
      .then((cfg) => {
        setMode(cfg.mode);
        setServerUrl(cfg.serverUrl ?? '');
        setServerCacheEnabled(cfg.serverCacheEnabled ?? true);
      })
      .catch(() => undefined)
      .finally(() => setNetLoaded(true));
  }, []);

  async function saveNetwork(): Promise<void> {
    setNetErr('');
    setNetBusy(true);
    try {
      const cfg: NetworkConfig = {
        mode,
        serverAddr: '',
        serverUrl: mode === 'server' ? serverUrl.trim() : '',
        serverCacheEnabled,
      };
      await window.buzz.setNetworkConfig(cfg);
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save.';
      const match = msg.match(/Must be a multiaddr ending in \/p2p\/<peerid>/);
      setNetErr(match ? match[0] : msg);
    } finally {
      setNetBusy(false);
    }
  }

  async function performReset(): Promise<void> {
    if (confirmText.trim().toUpperCase() !== 'RESET') {
      setResetErr('Type RESET to confirm.');
      return;
    }
    setResetErr('');
    setResetBusy(true);
    try {
      await window.buzz.factoryReset();
      onReset?.();
      onClose();
    } catch (e) {
      setResetErr(e instanceof Error ? e.message : 'Failed.');
    } finally {
      setResetBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Settings</div>
        <div className="settings-body">
          <div className="settings-nav">
            <button
              className={`settings-nav-item${section === 'network' ? ' active' : ''}`}
              onClick={() => setSection('network')}
            >
              Network
            </button>
            <button
              className={`settings-nav-item${section === 'reset' ? ' active' : ''}`}
              onClick={() => setSection('reset')}
            >
              Reset
            </button>
          </div>
          <div className="settings-content">
            {section === 'network' && (
              <div className="modal-body">
                {!netLoaded ? (
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
                        Discover peers via the public libp2p bootstrap nodes plus mDNS on the
                        local network. End-to-end encrypted via Noise XX.
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
                          <strong>Server</strong> — connect to a Hive server
                        </span>
                      </label>
                      <div className="muted small">
                        Connect to a Hive server for presence, message delivery, and offline storage.
                        End-to-end encrypted — the server only stores ciphertext.
                      </div>
                      {mode === 'server' && (
                        <div className="row indent">
                          <label className="label">Hive server URL</label>
                          <input
                            className="bevel-in"
                            value={serverUrl}
                            onChange={(e) => setServerUrl(e.target.value)}
                            placeholder="wss://hive.example.com:7700"
                            spellCheck={false}
                            autoFocus
                          />
                          <label className="checkbox" style={{ marginTop: 8 }}>
                            <input
                              type="checkbox"
                              checked={serverCacheEnabled}
                              onChange={(e) => setServerCacheEnabled(e.target.checked)}
                            />
                            <span>Cache messages locally</span>
                          </label>
                          <div className="muted small" style={{ marginTop: 4 }}>
                            When enabled, messages are stored in your encrypted local database in addition to the server.
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="error">{netErr}</div>
                  </>
                )}
              </div>
            )}

            {section === 'reset' && (
              <div className="modal-body">
                <div className="settings-danger">
                  <strong>Reset all local data</strong>
                  <div className="muted small" style={{ marginTop: 6 }}>
                    Deletes <em>every</em> screen name on this computer along with all
                    encrypted message history, buddies, chat rooms, and the network-mode
                    setting. This cannot be undone. Your peer identity (buddy code) will
                    be regenerated when you create a new screen name.
                  </div>
                  <div className="row" style={{ marginTop: 10 }}>
                    <label className="label">Type RESET to confirm</label>
                    <input
                      className="bevel-in"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder="RESET"
                      spellCheck={false}
                    />
                  </div>
                  <div className="error">{resetErr}</div>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="modal-actions">
          <button onClick={onClose} disabled={netBusy || resetBusy}>
            {section === 'reset' ? 'Cancel' : 'Close'}
          </button>
          {section === 'network' && (
            <button onClick={saveNetwork} disabled={netBusy || !netLoaded}>
              Save
            </button>
          )}
          {section === 'reset' && (
            <button
              className="danger"
              onClick={performReset}
              disabled={resetBusy || confirmText.trim().toUpperCase() !== 'RESET'}
            >
              {resetBusy ? 'Resetting…' : 'Reset Everything'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
