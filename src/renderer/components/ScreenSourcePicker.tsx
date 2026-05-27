import { useEffect, useState } from 'react';
import type { ScreenShareResolution, ScreenShareSource } from '@shared/schemas';
import { SCREEN_RESOLUTION_PRESETS } from './useScreenCapture';

type Props = {
  open: boolean;
  onCancel: () => void;
  onShare: (source: ScreenShareSource, resolution: ScreenShareResolution) => void;
};

export function ScreenSourcePicker({ open, onCancel, onShare }: Props): JSX.Element | null {
  const [sources, setSources] = useState<ScreenShareSource[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [resolution, setResolution] = useState<ScreenShareResolution>('720p');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError('');
    void window.buzz.talkGetScreenSources()
      .then((result) => {
        if (cancelled) return;
        setSources(result.sources);
        setSelectedId((current) => current || result.sources[0]?.id || '');
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not list screens');
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;
  const selected = sources.find((source) => source.id === selectedId);

  return (
    <div className="ss-backdrop">
      <div className="ss-picker bevel-out">
        <div className="ss-picker-title">Share Screen</div>
        <div className="ss-picker-body">
          {error ? <div className="error">{error}</div> : null}
          <div className="ss-source-grid bevel-in">
            {sources.length === 0 && !error ? <div className="ss-empty">Looking for screens and windows...</div> : null}
            {sources.map((source) => (
              <button
                key={source.id}
                className={`ss-source ${source.id === selectedId ? 'selected' : ''}`}
                onClick={() => setSelectedId(source.id)}
                title={source.name}
              >
                <span className="ss-thumb">
                  {source.thumbnailDataUrl ? <img src={source.thumbnailDataUrl} alt="" /> : <span className="ss-no-thumb" />}
                </span>
                <span className="ss-source-name">{source.name}</span>
                <span className="ss-source-kind">{source.kind === 'screen' ? 'Display' : 'Window'}</span>
              </button>
            ))}
          </div>
          <div className="ss-options">
            <span>Resolution</span>
            <div className="ss-resolution">
              {(Object.keys(SCREEN_RESOLUTION_PRESETS) as ScreenShareResolution[]).map((key) => (
                <button
                  key={key}
                  className={resolution === key ? 'selected' : ''}
                  onClick={() => setResolution(key)}
                >
                  {SCREEN_RESOLUTION_PRESETS[key].label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="ss-picker-actions">
          <button onClick={onCancel}>Cancel</button>
          <button disabled={!selected} onClick={() => selected && onShare(selected, resolution)}>Share</button>
        </div>
      </div>
    </div>
  );
}