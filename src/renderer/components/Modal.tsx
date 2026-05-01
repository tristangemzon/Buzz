import React from 'react';

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}): JSX.Element {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.25)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div className="bevel-out" style={{ width: props.width ?? 320, padding: 0 }}>
        <div className="titlebar">
          <span>{props.title}</span>
          <span style={{ flex: 1 }} />
          <button onClick={props.onClose}>×</button>
        </div>
        <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {props.children}
        </div>
      </div>
    </div>
  );
}
