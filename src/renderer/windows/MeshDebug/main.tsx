import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyPlatformTheme } from '../../theme/applyPlatform';
import { WindowChrome } from '../../components/WindowChrome';
import type { MeshDebugInfo } from '@shared/types';

function StateTag({ state }: { state: MeshDebugInfo['meshState'] }): JSX.Element {
  const colors: Record<MeshDebugInfo['meshState'], string> = {
    connected: '#00aa00',
    connecting: '#cc8800',
    error: '#cc0000',
    stopped: '#888888',
  };
  return (
    <span
      style={{
        color: colors[state],
        fontWeight: 'bold',
        textTransform: 'uppercase',
        fontSize: 11,
      }}
    >
      {state}
    </span>
  );
}

function App(): JSX.Element {
  const [info, setInfo] = useState<MeshDebugInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [ts, setTs] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const data = await window.buzz.getMeshDebug();
      setInfo(data);
      setTs(new Date());
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to fetch debug info.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void applyPlatformTheme(window.buzz);
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 5_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div className="window">
      <WindowChrome title="Buzz Mesh Debug" canMaximize={false} />
      <div style={{ padding: '10px 12px', fontFamily: 'inherit', fontSize: 12, overflowY: 'auto', height: 'calc(100% - 60px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <strong style={{ fontSize: 13 }}>Buzz Mesh Debug</strong>
          <button
            className="btn"
            onClick={() => void refresh()}
            disabled={loading}
            style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px' }}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {err && <div style={{ color: '#cc0000', marginBottom: 8 }}>{err}</div>}

        {ts && (
          <div style={{ color: '#888', fontSize: 10, marginBottom: 10 }}>
            Last updated: {ts.toLocaleTimeString()} (auto-refreshes every 5 s)
          </div>
        )}

        {info && (
          <>
            {/* ── Overview ── */}
            <div className="bevel-out" style={{ padding: '8px 10px', marginBottom: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <tbody>
                  <tr>
                    <td style={labelStyle}>Network mode</td>
                    <td><code>{info.mode}</code></td>
                  </tr>
                  <tr>
                    <td style={labelStyle}>Mesh state</td>
                    <td><StateTag state={info.meshState} /></td>
                  </tr>
                  <tr>
                    <td style={labelStyle}>Tailscale IP</td>
                    <td><code>{info.meshIp ?? '—'}</code></td>
                  </tr>
                  <tr>
                    <td style={labelStyle}>SOCKS5 port</td>
                    <td><code>{info.socksPort ?? '—'}</code></td>
                  </tr>
                  <tr>
                    <td style={labelStyle}>Pending out-requests</td>
                    <td><code>{info.pendingOutRequests}</code></td>
                  </tr>
                </tbody>
              </table>
              {info.meshError && (
                <div style={{ marginTop: 8, color: '#cc0000', wordBreak: 'break-word', fontSize: 11 }}>
                  <strong>Error:</strong> {info.meshError}
                </div>
              )}
            </div>

            {/* ── Dial errors ── */}
            {info.dialErrors.length > 0 && (
              <>
                <div style={{ marginBottom: 6, fontWeight: 'bold', color: '#cc0000' }}>
                  Recent dial errors ({info.dialErrors.length})
                </div>
                <div className="bevel-in" style={{ padding: '6px 8px', marginBottom: 8, maxHeight: 100, overflowY: 'auto' }}>
                  {info.dialErrors.map((e, i) => (
                    <div key={i} style={{ fontFamily: 'monospace', fontSize: 10, color: '#cc0000', wordBreak: 'break-all', marginBottom: 2 }}>
                      {e}
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* ── Tailnet peers ── */}
            <div style={{ marginBottom: 6, fontWeight: 'bold' }}>
              Tailnet peers ({info.tailnetPeers.length})
            </div>
            <div className="bevel-in" style={{ padding: '6px 8px', marginBottom: 8, maxHeight: 90, overflowY: 'auto' }}>
              {info.tailnetPeers.length === 0 ? (
                <span style={{ color: '#888' }}>No tailnet peers visible yet.</span>
              ) : (
                info.tailnetPeers.map((ip) => (
                  <div key={ip} style={{ fontFamily: 'monospace', fontSize: 11 }}>{ip}</div>
                ))
              )}
            </div>

            {/* ── libp2p connections ── */}
            <div style={{ marginBottom: 6, fontWeight: 'bold' }}>
              libp2p connections ({info.libp2pPeers.length})
            </div>
            <div className="bevel-in" style={{ padding: '6px 8px', maxHeight: 160, overflowY: 'auto' }}>
              {info.libp2pPeers.length === 0 ? (
                <span style={{ color: '#888' }}>No libp2p peers connected.</span>
              ) : (
                info.libp2pPeers.map(({ peerId, addrs }) => (
                  <div key={peerId} style={{ marginBottom: 6 }}>
                    <div style={{ fontFamily: 'monospace', fontSize: 10, color: '#444', wordBreak: 'break-all' }}>
                      {peerId}
                    </div>
                    {addrs.map((a) => (
                      <div key={a} style={{ fontFamily: 'monospace', fontSize: 10, color: '#006', paddingLeft: 8, wordBreak: 'break-all' }}>
                        {a}
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  color: '#555',
  paddingRight: 12,
  paddingBottom: 3,
  whiteSpace: 'nowrap',
  verticalAlign: 'top',
};

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
