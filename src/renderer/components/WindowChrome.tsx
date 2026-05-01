import React from 'react';

declare global {
  interface Window {
    buzzWindows: {
      openIm(peerId: string): Promise<void>;
      openVideoCall(peerId: string): Promise<void>;
      openBuddyList(): Promise<void>;
      openChat(roomId: string): Promise<void>;
      openGame(peerId: string, kind: string, initiator?: boolean): Promise<void>;
      openSettings(): Promise<void>;
      openMeshDebug(): Promise<void>;
      minimize(): Promise<void>;
      toggleMax(): Promise<void>;
      close(): Promise<void>;
      isMaximizable(): Promise<boolean>;
    };
  }
}

type Props = {
  title: React.ReactNode;
  // When false, hides the maximize button (e.g. for the SignOn window).
  canMaximize?: boolean;
  // Optional extra controls injected on the right (e.g. a status pill).
  extras?: React.ReactNode;
  onBeforeClose?: () => void | Promise<void>;
};

// Classic Win9x/AIM-style titlebar with custom minimize / maximize / close
// buttons. The whole bar is the OS drag handle; the buttons opt out via the
// `controls` class so they remain clickable.
export function WindowChrome({
  title,
  canMaximize = true,
  extras,
  onBeforeClose,
}: Props): JSX.Element {
  return (
    <div className="titlebar">
      <span className="runner" />
      <span className="title">{title}</span>
      {extras}
      <span className="controls">
        <button
          aria-label="Minimize"
          title="Minimize"
          onClick={() => void window.buzzWindows.minimize()}
        >
          {'\u2013'}
        </button>
        {canMaximize && (
          <button
            aria-label="Maximize"
            title="Maximize"
            onClick={() => void window.buzzWindows.toggleMax()}
          >
            {'\u25A1'}
          </button>
        )}
        <button
          className="close"
          aria-label="Close"
          title="Close"
          onClick={async () => {
            try {
              await onBeforeClose?.();
            } finally {
              void window.buzzWindows.close();
            }
          }}
        >
          {'\u2715'}
        </button>
      </span>
    </div>
  );
}
