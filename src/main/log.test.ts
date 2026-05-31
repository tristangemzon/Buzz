import { describe, expect, it } from 'vitest';
import { redact } from './log.js';

describe('redact', () => {
  it('redacts libp2p PeerIds, keeping last 6 chars for triage', () => {
    const id = '12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X';
    expect(redact(`connected to ${id} ok`)).toBe(`connected to <peer:9HyQ6X> ok`);
  });

  it('redacts CIDv0 (Qm…) peer ids', () => {
    const id = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    expect(redact(id)).toMatch(/^<peer:[1-9A-HJ-NP-Za-km-z]{6}>$/);
  });

  it('redacts IPv4 addresses', () => {
    expect(redact('multiaddr /ip4/192.168.1.5/tcp/4001')).toBe('multiaddr /ip4/<ipv4>/tcp/4001');
  });

  it('redacts IPv6 addresses', () => {
    expect(redact('addr 2001:db8::1 ok')).toBe('addr <ipv6> ok');
  });

  it('passes through plain text unchanged', () => {
    expect(redact('joined room "general" as alice')).toBe('joined room "general" as alice');
  });

  it('stringifies non-strings and redacts inside JSON', () => {
    const out = redact({ peer: '12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X', host: '10.0.0.1' });
    expect(out).toContain('<peer:9HyQ6X>');
    expect(out).toContain('<ipv4>');
  });

  it('handles errors by including name + message + stack', () => {
    const out = redact(new Error('bad 12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X'));
    expect(out).toContain('Error: bad <peer:9HyQ6X>');
  });
});
