import { app, dialog, ipcMain, BrowserWindow } from 'electron';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import * as https from 'node:https';
import * as http from 'node:http';
import { z, type ZodTypeAny } from 'zod';

import { IPC } from '@shared/ipc.js';
import {
  AddBuddyReq,
  BuddyRequestSendReq,
  CreateIdentityReq,
  HistoryReq,
  ImMessage,
  PeerIdStr,
  Prefs,
  Profile,
  PresenceSetStatusReq,
  RoomCreateReq,
  RoomHistoryReq,
  RoomInviteReq,
  RoomLeaveReq,
  RoomSendReq,
  RoomChannelsListReq,
  RoomChannelCreateReq,
  RoomChannelDeleteReq,
  RoomVoiceJoinReq,
  RoomVoiceLeaveReq,
  MailboxAddRelayReq,
  MailboxRemoveRelayReq,
  NetworkConfig,
  SendImReq,
  SetPrefsReq,
  ServerRegisterReq,
  ServerUnlockReq,
  UnlockReq,
  Uuid,
  XferOfferReq,
  XferRespondReq,
} from '@shared/schemas.js';
import type { Platform } from '@shared/types.js';

import * as repos from '../db/repos.js';
import { sodium, Keystore } from '../crypto/keystore.js';
import { loadNetworkConfig, saveNetworkConfig } from '../network.js';
import * as profiles from '../profiles.js';
import type { Session } from '../session.js';

function platform(): Platform {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

function handle<S extends ZodTypeAny, R>(
  channel: string,
  schema: S | null,
  fn: (arg: z.infer<S>) => Promise<R> | R,
): void {
  ipcMain.handle(channel, async (_e, raw: unknown) => {
    const arg = schema ? schema.parse(raw) : (undefined as z.infer<S>);
    return fn(arg);
  });
}

export interface RegisterIpcOpts {
  /** Called (on the main thread) after the session is successfully locked. */
  onLocked?: () => void;
}

export function registerIpc(session: Session, opts: RegisterIpcOpts = {}): void {
  // ── auth ──────────────────────────────────────────────────────────────────
  handle(IPC.AuthHasIdentity, null, () => session.listProfiles().length > 0);
  handle(IPC.AuthListProfiles, null, () => session.listProfiles());
  handle(IPC.AuthCreate, CreateIdentityReq, async ({ screenName, passphrase }) => {
    return session.create(screenName, passphrase);
  });
  handle(IPC.AuthUnlock, UnlockReq, async ({ profileId, passphrase }) => {
    const r = await session.unlock(profileId, passphrase);
    return { ok: true as const, profileId: r.profileId, buddyCode: r.buddyCode };
  });
  handle(IPC.AuthLock, null, async () => {
    await session.lock();
    opts.onLocked?.();
  });
  handle(IPC.AuthFactoryReset, null, () => session.factoryReset());
  handle(
    IPC.AuthMigrateDb,
    z.object({ profileId: z.string(), passphrase: z.string() }),
    ({ profileId, passphrase }) => session.migrateDb(profileId, passphrase),
  );
  handle(IPC.AppGetVersion, null, () => app.getVersion());
  handle(IPC.AuthGetPlatform, null, () => platform());
  handle(IPC.AuthGetMyId, null, () => ({
    peerId: session.peerIdStr(),
    buddyCode: session.buddyCode(),
    screenName: session.screenName,
  }));

  // ── buddies ───────────────────────────────────────────────────────────────
  handle(IPC.BuddiesList, null, () => repos.listBuddies(requireDb(session)));
  // Adding a buddy now sends a request and stores a local outbound pending
  // entry. The buddy row is only created once the remote side approves.
  handle(IPC.BuddiesAdd, AddBuddyReq, async ({ buddyCode, alias, group }) => {
    const db = requireDb(session);
    // If they're already a buddy, treat this as a no-op success.
    if (db.prepare('SELECT 1 FROM buddies WHERE peer_id=?').get(buddyCode)) {
      return repos
        .listBuddies(db)
        .find((b) => b.peerId === buddyCode) ?? null;
    }
    await session.sendBuddyRequest(buddyCode, alias, group);
    return null;
  });
  handle(IPC.BuddiesSendRequest, BuddyRequestSendReq, async ({ buddyCode, alias, group }) => {
    await session.sendBuddyRequest(buddyCode, alias, group);
  });
  handle(IPC.BuddiesListRequests, null, () => repos.listBuddyRequests(requireDb(session)));
  handle(IPC.BuddiesApproveRequest, PeerIdStr, async (peerId) =>
    session.approveBuddyRequest(peerId),
  );
  handle(IPC.BuddiesDenyRequest, PeerIdStr, async (peerId) =>
    session.denyBuddyRequest(peerId),
  );
  handle(IPC.BuddiesCancelRequest, PeerIdStr, (peerId) => {
    repos.deleteBuddyRequest(requireDb(session), peerId);
  });
  handle(IPC.BuddiesRemove, PeerIdStr, (peerId) => repos.removeBuddy(requireDb(session), peerId));
  handle(
    IPC.BuddiesRename,
    z.object({ peerId: PeerIdStr, alias: z.string().min(1).max(64) }),
    ({ peerId, alias }) => repos.renameBuddy(requireDb(session), peerId, alias),
  );
  handle(
    IPC.BuddiesBlock,
    z.object({ peerId: PeerIdStr, blocked: z.boolean() }),
    ({ peerId, blocked }) => repos.blockBuddy(requireDb(session), peerId, blocked),
  );
  handle(IPC.BuddiesWarn,
    z.object({ peerId: PeerIdStr, delta: z.number().int().min(-100).max(100).default(10) }),
    ({ peerId, delta }) => repos.warnBuddy(requireDb(session), peerId, delta),
  );

  // ── auto-discovery ────────────────────────────────────────────────────────
  handle(IPC.DiscoveryList, null, () => session.listDiscovered());

  // ── im ────────────────────────────────────────────────────────────────────
  handle(IPC.ImSend, SendImReq, async ({ toPeerId, body }) => {
    const db = requireDb(session);
    // Server mode: seal-box encrypt and route via HiveClient.
    const hive = session.hiveClient;
    if (hive) {
      const cipherB64 = hive.sealMessage(toPeerId, body);
      if (!cipherB64) throw new Error('Peer encryption key not available yet — try again in a moment.');
      const msg: ImMessage = ImMessage.parse({
        id: randomUUID(),
        peerId: toPeerId,
        direction: 'out',
        ts: Date.now(),
        body,
        status: 'queued',
      });
      const networkCfg = loadNetworkConfig();
      if (networkCfg.serverCacheEnabled) repos.insertMessage(db, msg);
      hive.sendIm(toPeerId, msg.id, msg.ts, cipherB64);
      msg.status = 'sent';
      if (networkCfg.serverCacheEnabled) repos.setMessageStatus(db, msg.id, 'sent');
      return msg;
    }
    const im = session.im;
    if (!im) throw new Error('Locked');
    const msg: ImMessage = ImMessage.parse({
      id: randomUUID(),
      peerId: toPeerId,
      direction: 'out',
      ts: Date.now(),
      body,
      status: 'queued',
    });
    repos.insertMessage(db, msg);
    try {
      await im.send(toPeerId, { type: 'msg', id: msg.id, ts: msg.ts, body: msg.body });
      msg.status = 'sent';
      repos.setMessageStatus(db, msg.id, 'sent');
    } catch (err) {
      // Direct send failed (peer offline / no route). If we have offline
      // mailbox relays configured, try to push a sealed envelope through
      // them so the recipient picks it up next time they're online.
      const mbx = session.mailbox;
      let queued = false;
      if (mbx) {
        queued = await mbx
          .pushToRelays(toPeerId, { id: msg.id, ts: msg.ts, body: msg.body })
          .catch(() => false);
      }
      if (queued) {
        msg.status = 'sent';
        repos.setMessageStatus(db, msg.id, 'sent');
      } else {
        msg.status = 'failed';
        repos.setMessageStatus(db, msg.id, 'failed');
        throw err;
      }
    }
    return msg;
  });
  handle(
    IPC.ImTyping,
    z.object({ peerId: PeerIdStr, typing: z.boolean() }),
    async ({ peerId: toPeerId, typing }) => {
      if (session.hiveClient) return; // typing indicators not supported in server mode
      const im = session.im;
      if (!im) return;
      await im.send(toPeerId, { type: 'typing', typing }).catch(() => {});
    },
  );
  handle(IPC.ImHistory, HistoryReq, ({ peerId, limit, before }) =>
    repos.history(requireDb(session), peerId, limit, before),
  );
  handle(IPC.ImMarkRead, PeerIdStr, (peerId) => {
    const db = requireDb(session);
    const changed = repos.markImRead(db, peerId);
    if (changed > 0) session.broadcastUnread();
  });
  handle(IPC.UnreadGet, null, () => session.unreadSnapshot());

  // ── prefs ────────────────────────────────────────────────────────────────────────────────────────────
  // Pre-unlock callers (e.g. the SignOn window applying platform theme)
  // should get sane defaults rather than an error.
  handle(IPC.PrefsGet, null, () => {
    if (!session.db) return Prefs.parse({});
    return repos.getPrefs(session.db);
  });
  handle(IPC.PrefsSet, SetPrefsReq, (patch) => {
    const updated = repos.setPrefs(requireDb(session), patch);
    // Broadcast theme changes to all open windows so they re-apply live.
    if (patch.theme) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('evt:themeChanged', updated.theme);
      }
    }
    return updated;
  });

  // ── network mode (pre-unlock readable) ───────────────────────────────────
  handle(IPC.NetworkGet, null, () => loadNetworkConfig());
  handle(IPC.NetworkSet, NetworkConfig, (cfg) => saveNetworkConfig(cfg));

  // ── presence ─────────────────────────────────────────────────────────────────────────────────────────
  handle(IPC.PresenceSetStatus, PresenceSetStatusReq, async ({ status, awayMessage }) => {
    const p = session.presence;
    if (p) {
      // P2P mode — delegate to PresenceManager.
      if (status === 'away' && typeof awayMessage === 'string') {
        repos.setPrefs(requireDb(session), { awayMessage });
      }
      return p.setStatus(status, awayMessage);
    }
    // Hive server mode — presence is managed by HiveClient.
    if (session.state === 'unlocked' && session.db) {
      if (status === 'online' || status === 'invisible') {
        repos.setPrefs(session.db, { lastStatus: status });
      }
      if (status === 'away' && typeof awayMessage === 'string') {
        repos.setPrefs(session.db, { awayMessage });
      }
      session.hiveClient?.setStatus(status as 'online' | 'away' | 'idle' | 'invisible' | 'offline', awayMessage);
      return;
    }
    throw new Error('Locked');
  });
  handle(IPC.PresenceGetSelf, null, () => {
    const p = session.presence;
    if (p) return p.getSelf();
    // Hive server mode — synthesise SelfPresence from persisted prefs.
    if (session.state === 'unlocked' && session.db) {
      const prefs = repos.getPrefs(session.db);
      const base = prefs.lastStatus === 'invisible' ? 'invisible' as const : 'online' as const;
      return {
        status: base,
        baseStatus: base,
        awayMessage: prefs.awayMessage || undefined,
      };
    }
    throw new Error('Locked');
  });
  handle(IPC.PresenceGetPeer, PeerIdStr, (peerId) => session.getPeerStatus(peerId));

  // ── profile ──────────────────────────────────────────────────────────────
  handle(IPC.ProfileGetMy, null, () => {
    if (!session.db) return Profile.parse({});
    return repos.getPrefs(session.db).profile;
  });
  handle(IPC.ProfileSetMy, Profile.partial(), async (patch) => {
    const db = requireDb(session);
    const current = repos.getPrefs(db).profile;
    const merged = Profile.parse({ ...current, ...patch });
    repos.setPrefs(db, { profile: merged });
    // Push fresh profile to all currently-connected peers.
    if (session.presence) await session.presence.rebroadcast();
    return merged;
  });
  handle(IPC.ProfileGetPeer, PeerIdStr, (peerId) => {
    const db = requireDb(session);
    return repos.getPeerProfile(db, peerId);
  });

  // ── file transfer ────────────────────────────────────────────────────────
  handle(IPC.XferOffer, XferOfferReq, async ({ toPeerId }) => {
    if (session.hiveClient) throw new Error('File transfer is not yet supported in server mode.');
    const xfer = session.xfer;
    if (!xfer) throw new Error('Locked');
    const sender = BrowserWindow.getFocusedWindow() ?? undefined;
    const pick = await dialog.showOpenDialog(sender as BrowserWindow, {
      title: 'Send a File',
      properties: ['openFile'],
    });
    if (pick.canceled || !pick.filePaths[0]) return { id: '', cancelled: true } as const;
    const filePath = pick.filePaths[0];
    // Pre-insert a row so the IM window can show progress immediately.
    const id = randomUUID();
    const stat = await import('node:fs/promises').then((m) => m.stat(filePath));
    const fileName = path.basename(filePath);
    if (session.db) {
      repos.insertTransfer(session.db, {
        id,
        peerId: toPeerId,
        direction: 'out',
        fileName,
        fileSize: stat.size,
        fileHash: '',
        status: 'active',
        savedPath: filePath,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    // The XferService allocates its own id internally; surface that through
    // the started-event chain. Kick off, then return the picked metadata.
    void xfer
      .sendFile(toPeerId, filePath)
      .catch(() => undefined);
    return {
      id,
      cancelled: false,
      fileName,
      fileSize: stat.size,
      peerId: toPeerId,
    } as const;
  });
  handle(IPC.XferRespond, XferRespondReq, async ({ id, accept }) => {
    if (session.hiveClient) throw new Error('File transfer is not yet supported in server mode.');
    const xfer = session.xfer;
    if (!xfer) throw new Error('Locked');
    if (!accept) {
      xfer.respond(id, false);
      return { ok: true as const };
    }
    const sender = BrowserWindow.getFocusedWindow() ?? undefined;
    // Look up the offer's filename from DB to suggest a default save name.
    const row = session.db
      ? (session.db
          .prepare('SELECT file_name as fileName FROM transfers WHERE id=?')
          .get(id) as { fileName?: string } | undefined)
      : undefined;
    const save = await dialog.showSaveDialog(sender as BrowserWindow, {
      title: 'Save File As',
      defaultPath: row?.fileName,
    });
    if (save.canceled || !save.filePath) {
      xfer.respond(id, false);
      return { ok: true as const };
    }
    if (session.db) {
      repos.updateTransferStatus(session.db, id, 'active', save.filePath);
    }
    xfer.respond(id, true, save.filePath);
    return { ok: true as const };
  });

  // ── voice talk ───────────────────────────────────────────────────────────
  handle(
    IPC.TalkInvite,
    z.object({ peerId: PeerIdStr, kind: z.enum(['voice', 'video']).optional() }),
    async ({ peerId, kind }) => {
      return session.startCall(peerId, kind ?? 'voice');
    },
  );
  handle(IPC.TalkAccept, z.object({ callId: Uuid }), async ({ callId }) => {
    await session.acceptCall(callId);
  });
  handle(
    IPC.TalkReject,
    z.object({ callId: Uuid, reason: z.string().optional() }),
    async ({ callId, reason }) => {
      await session.rejectCall(callId, reason);
    },
  );
  handle(IPC.TalkEnd, z.object({ callId: Uuid }), async ({ callId }) => {
    await session.endCall(callId);
  });
  handle(
    IPC.TalkAudio,
    z.object({ callId: Uuid, data: z.instanceof(Uint8Array) }),
    async ({ callId, data }) => {
      await session.sendCallAudio(callId, data);
    },
  );
  handle(
    IPC.TalkVideo,
    z.object({ callId: Uuid, data: z.instanceof(Uint8Array) }),
    async ({ callId, data }) => {
      await session.sendCallVideo(callId, data);
    },
  );
  handle(
    IPC.TalkVideoState,
    z.object({ callId: Uuid, on: z.boolean() }),
    async ({ callId, on }) => {
      await session.setCallVideo(callId, on);
    },
  );
  handle(IPC.TalkGetActive, z.object({ peerId: PeerIdStr }), ({ peerId }) =>
    session.getActiveCall(peerId),
  );

  // ── chat rooms ───────────────────────────────────────────────────────────
  handle(IPC.RoomsList, null, () => {
    const db = requireDb(session);
    return repos.listRooms(db).map(({ keyB64: _k, ...rest }) => rest);
  });
  handle(IPC.RoomsCreate, RoomCreateReq, async ({ name, members }) => {
    const db = requireDb(session);
    // Server mode: generate room key locally, seal for each member, create via HiveClient.
    const hive = session.hiveClient;
    if (hive) {
      const s = await sodium();
      const key = s.randombytes_buf(32);
      const keyB64 = s.to_base64(key, s.base64_variants.ORIGINAL);
      const createdAt = Date.now();
      const roomId = randomUUID();
      const myPeerId = session.peerIdStr();
      const fullMembers = Array.from(new Set([myPeerId, ...members]));
      const defaultChannel = { id: randomUUID(), name: 'general', kind: 'text' as const, isDefault: true, createdAt };
      const keyEnvelopes = fullMembers
        .map((pid) => { const c = hive.sealMessage(pid, keyB64); return c ? { peerId: pid, cipherB64: c } : null; })
        .filter((e): e is { peerId: string; cipherB64: string } => e !== null);
      hive.createRoom(roomId, name, keyEnvelopes, fullMembers);
      repos.upsertRoom(db, { id: roomId, name, keyB64, createdAt });
      repos.setRoomMembers(db, roomId, fullMembers);
      repos.upsertRoomChannel(db, { ...defaultChannel, roomId });
      session.cacheRoomKey(roomId, key);
      session.cacheRoomMembers(roomId, fullMembers);
      return { id: roomId, name, members: fullMembers, createdAt };
    }
    const rooms = session.rooms;
    if (!rooms) throw new Error('Locked');
    // Build the default channel UP FRONT so we can ship its id along with
    // the invite — every member then uses the same default-channel id.
    const createdAt = Date.now();
    const defaultChannel = {
      id: randomUUID(),
      name: 'general',
      kind: 'text' as const,
      isDefault: true,
      createdAt,
    };
    const { roomId, keyB64, members: full } = await rooms.createRoom({
      name,
      members,
      channels: [defaultChannel],
    });
    repos.upsertRoom(db, { id: roomId, name, keyB64, createdAt });
    repos.setRoomMembers(db, roomId, full);
    repos.upsertRoomChannel(db, { ...defaultChannel, roomId });
    const s = await sodium();
    session.cacheRoomKey(roomId, s.from_base64(keyB64, s.base64_variants.ORIGINAL));
    session.cacheRoomMembers(roomId, full);
    return { id: roomId, name, members: full, createdAt };
  });
  handle(IPC.RoomsInvite, RoomInviteReq, async ({ roomId, peerId }) => {
    const db = requireDb(session);
    // Server mode.
    const hive = session.hiveClient;
    if (hive) {
      const room = repos.getRoom(db, roomId);
      if (!room) throw new Error('Unknown room');
      const keyEnvelopeB64 = hive.sealMessage(peerId, room.keyB64);
      if (!keyEnvelopeB64) throw new Error('Peer encryption key not available yet.');
      const fullMembers = Array.from(new Set([...session.getRoomMembers(roomId), peerId]));
      hive.inviteToRoom(roomId, peerId, keyEnvelopeB64);
      repos.setRoomMembers(db, roomId, fullMembers);
      session.cacheRoomMembers(roomId, fullMembers);
      return { id: roomId, name: room.name, members: fullMembers, createdAt: room.createdAt };
    }
    const rooms = session.rooms;
    if (!rooms) throw new Error('Locked');
    const room = repos.getRoom(db, roomId);
    if (!room) throw new Error('Unknown room');
    // Snapshot channels so the invitee inherits the same channel ids.
    const channels = repos.listRoomChannels(db, roomId).map((c) => ({
      id: c.id,
      name: c.name,
      isDefault: c.isDefault,
      createdAt: c.createdAt,
    }));
    const members = await rooms.invite(roomId, peerId, room.name, channels);
    repos.setRoomMembers(db, roomId, members);
    session.cacheRoomMembers(roomId, members);
    return { id: roomId, name: room.name, members, createdAt: room.createdAt };
  });
  handle(IPC.RoomsLeave, RoomLeaveReq, async ({ roomId }) => {
    const db = requireDb(session);
    // Server mode: no leave signal to the server yet; just clean up locally.
    if (session.hiveClient) {
      repos.deleteRoom(db, roomId);
      session.forgetRoom(roomId);
      return { ok: true as const };
    }
    const rooms = session.rooms;
    if (!rooms) throw new Error('Locked');
    await rooms.leave(roomId);
    repos.deleteRoom(db, roomId);
    session.forgetRoom(roomId);
    return { ok: true as const };
  });
  handle(IPC.RoomsSend, RoomSendReq, async ({ roomId, channelId, body }) => {
    const db = requireDb(session);
    // Server mode: secretbox-encrypt with cached room key, send via HiveClient.
    const hive = session.hiveClient;
    if (hive) {
      const ch = repos.getRoomChannel(db, channelId);
      if (!ch || ch.roomId !== roomId) throw new Error('Unknown channel');
      const key = session.getRoomKey(roomId);
      if (!key) throw new Error('Room key not available — rejoin the room.');
      const s = await sodium();
      const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
      const ct = s.crypto_secretbox_easy(s.from_string(body), nonce, key);
      const cipherB64 =
        s.to_base64(nonce, s.base64_variants.ORIGINAL) + ':' +
        s.to_base64(ct, s.base64_variants.ORIGINAL);
      const id = randomUUID();
      const ts = Date.now();
      hive.sendRoomMsg(roomId, channelId, id, ts, cipherB64);
      const stored = {
        id, roomId, channelId,
        fromPeerId: session.peerIdStr(),
        fromName: session.screenName,
        direction: 'out' as const,
        ts,
        body, // store plaintext locally
      };
      const networkCfg = loadNetworkConfig();
      if (networkCfg.serverCacheEnabled) repos.insertRoomMessage(db, stored);
      return stored;
    }
    const rooms = session.rooms;
    if (!rooms) throw new Error('Locked');
    // Validate the channel belongs to this room.
    const ch = repos.getRoomChannel(db, channelId);
    if (!ch || ch.roomId !== roomId) throw new Error('Unknown channel');
    const { id, ts } = await rooms.sendMessage(roomId, channelId, body);
    const stored = {
      id,
      roomId,
      channelId,
      fromPeerId: session.peerIdStr(),
      fromName: session.screenName,
      direction: 'out' as const,
      ts,
      body,
    };
    repos.insertRoomMessage(db, stored);
    return stored;
  });
  handle(IPC.RoomsHistory, RoomHistoryReq, ({ roomId, channelId, limit, before }) =>
    repos.roomHistory(requireDb(session), roomId, limit, before, channelId),
  );

  handle(IPC.RoomsListChannels, RoomChannelsListReq, ({ roomId }) =>
    repos.listRoomChannels(requireDb(session), roomId),
  );
  handle(IPC.RoomsCreateChannel, RoomChannelCreateReq, async ({ roomId, name, kind }) => {
    const db = requireDb(session);
    // Server mode.
    const hive = session.hiveClient;
    if (hive) {
      if (!repos.getRoom(db, roomId)) throw new Error('Unknown room');
      const ch = {
        id: randomUUID(),
        roomId,
        name,
        kind: kind ?? 'text',
        isDefault: false,
        createdAt: Date.now(),
      } as const;
      repos.upsertRoomChannel(db, ch);
      hive.addRoomChannel(roomId, ch.id, ch.name, ch.kind);
      return ch;
    }
    const rooms = session.rooms;
    if (!rooms) throw new Error('Locked');
    if (!repos.getRoom(db, roomId)) throw new Error('Unknown room');
    const ch = {
      id: randomUUID(),
      roomId,
      name,
      kind: kind ?? 'text',
      isDefault: false,
      createdAt: Date.now(),
    } as const;
    repos.upsertRoomChannel(db, ch);
    await rooms.broadcastChannelAdd(roomId, ch.id, ch.name, ch.kind);
    return ch;
  });
  handle(IPC.RoomsDeleteChannel, RoomChannelDeleteReq, async ({ roomId, channelId }) => {
    const db = requireDb(session);
    // Server mode: no broadcast protocol; delete locally.
    const hive = session.hiveClient;
    if (hive) {
      const ch = repos.getRoomChannel(db, channelId);
      if (!ch || ch.roomId !== roomId) throw new Error('Unknown channel');
      if (ch.isDefault) throw new Error('Cannot delete the default channel');
      repos.deleteRoomChannel(db, channelId);
      return { ok: true as const };
    }
    const rooms = session.rooms;
    if (!rooms) throw new Error('Locked');
    const ch = repos.getRoomChannel(db, channelId);
    if (!ch || ch.roomId !== roomId) throw new Error('Unknown channel');
    if (ch.isDefault) throw new Error('Cannot delete the default channel');
    repos.deleteRoomChannel(db, channelId);
    await rooms.broadcastChannelDel(roomId, channelId);
    return { ok: true as const };
  });
  handle(IPC.RoomsMarkRead, z.object({ roomId: Uuid }), ({ roomId }) => {
    repos.markRoomRead(requireDb(session), roomId);
    session.broadcastUnread();
  });
  handle(IPC.RoomsVoiceJoin, RoomVoiceJoinReq, async ({ roomId, channelId }) => {
    await session.roomVoiceJoin(roomId, channelId);
    return { ok: true as const };
  });
  handle(IPC.RoomsVoiceLeave, RoomVoiceLeaveReq, async ({ roomId, channelId }) => {
    await session.roomVoiceLeave(roomId, channelId);
    return { ok: true as const };
  });
  // Audio chunks come over a separate ipcMain.on (no return value, raw bytes).
  ipcMain.on(
    IPC.RoomsVoiceSendAudio,
    (_e, payload: { roomId: string; channelId: string }, data: Uint8Array) => {
      void session.roomVoiceSendAudio(payload.roomId, payload.channelId, data);
    },
  );

  // ── offline mailbox relay ────────────────────────────────────────────────
  handle(IPC.MailboxStats, null, () => {
    const db = requireDb(session);
    const prefs = repos.getPrefs(db);
    return {
      relayHeldCount: repos.mailboxCount(db),
      relays: prefs.mailboxRelays,
      lastPolledAt: session.mailbox?.lastPolledAt() ?? {},
    };
  });
  handle(IPC.MailboxAddRelay, MailboxAddRelayReq, ({ peerId }) => {
    const db = requireDb(session);
    const prefs = repos.getPrefs(db);
    const next = Array.from(new Set([...prefs.mailboxRelays, peerId])).slice(0, 8);
    repos.setPrefs(db, { mailboxRelays: next });
    return {
      relayHeldCount: repos.mailboxCount(db),
      relays: next,
      lastPolledAt: session.mailbox?.lastPolledAt() ?? {},
    };
  });
  handle(IPC.MailboxRemoveRelay, MailboxRemoveRelayReq, ({ peerId }) => {
    const db = requireDb(session);
    const prefs = repos.getPrefs(db);
    const next = prefs.mailboxRelays.filter((x) => x !== peerId);
    repos.setPrefs(db, { mailboxRelays: next });
    return {
      relayHeldCount: repos.mailboxCount(db),
      relays: next,
      lastPolledAt: session.mailbox?.lastPolledAt() ?? {},
    };
  });
  handle(IPC.MailboxPoll, null, async () => {
    const mbx = session.mailbox;
    if (!mbx) throw new Error('Locked');
    return mbx.pollAll();
  });

  // ── Games ──────────────────────────────────────────────────────────────
  handle(IPC.GameInvite, z.object({ toPeerId: z.string(), kind: z.string() }), async ({ toPeerId, kind }) => {
    await session.sendGameFrame(toPeerId, 'invite', kind);
  });
  handle(IPC.GameAccept, z.string(), async (toPeerId) => {
    await session.sendGameFrame(toPeerId, 'accept', 'checkers');
  });
  handle(IPC.GameDecline, z.string(), async (toPeerId) => {
    await session.sendGameFrame(toPeerId, 'decline', 'checkers');
  });
  handle(IPC.GameMove, z.object({ toPeerId: z.string(), kind: z.string(), path: z.array(z.number()) }), async ({ toPeerId, kind, path }) => {
    await session.sendGameFrame(toPeerId, 'move', kind, path);
  });
  handle(IPC.GameResign, z.string(), async (toPeerId) => {
    await session.sendGameFrame(toPeerId, 'resign', 'checkers');
  });

  // ── Server-mode account management ────────────────────────────────────────

  // Probe a Hive server and return its name + registered user list.
  handle(IPC.ServerDiscover, z.string(), async (serverUrl) => {
    const baseUrl = wssToHttps(serverUrl);
    const [info, users] = await Promise.all([
      hiveGet<{ serverName: string; version: string; registrationOpen: boolean }>(baseUrl + '/api/server-info'),
      hiveGet<Array<{ screenName: string; peerId: string }>>(baseUrl + '/api/users'),
    ]);
    return { serverName: info.serverName, registrationOpen: info.registrationOpen, users };
  });

  // Register a brand-new account on a Hive server and sign in.
  handle(IPC.ServerRegister, ServerRegisterReq, async ({ serverUrl, screenName, passphrase }) => {
    // Save server URL as the current network config before bringUp.
    await saveNetworkConfig({ mode: 'server', serverUrl, serverAddr: '', serverCacheEnabled: true });

    const profile = profiles.addProfile(screenName, false, serverUrl);
    try {
      const keystorePath = path.join(profiles.profileDir(profile.id), 'keystore.bin');
      const ks = new Keystore(keystorePath);
      const id = await ks.create(passphrase);

      // Derive the same peerId the HiveClient will use.
      const s = await sodium();
      const kp = s.crypto_sign_seed_keypair(id.seed);
      const pubKeyB64 = Buffer.from(kp.publicKey).toString('base64');
      const peerId = createHash('sha256').update(kp.publicKey).digest('hex');

      // Read back the encrypted keystore blob and encode for transport.
      const keystoreBlob = await readFile(keystorePath);
      const encryptedKeystoreB64 = keystoreBlob.toString('base64');

      // Register with the server.
      const baseUrl = wssToHttps(serverUrl);
      await hivePost(baseUrl + '/api/register', { screenName, peerId, pubKeyB64, encryptedKeystoreB64 });

      // Bring up the session (bringUp reads network.json which we saved above).
      await session.bringUp(id, profile.id, screenName);
      return { profileId: profile.id, buddyCode: session.buddyCode() };
    } catch (err) {
      profiles.removeProfile(profile.id);
      throw err;
    }
  });

  // Sign in to an existing account on a Hive server (downloads keystore if not cached).
  handle(IPC.ServerUnlockAccount, ServerUnlockReq, async ({ serverUrl, screenName, passphrase }) => {
    // Save server URL as the current network config before unlock.
    await saveNetworkConfig({ mode: 'server', serverUrl, serverAddr: '', serverCacheEnabled: true });

    // Find or create local profile entry.
    let profile = profiles.findServerProfile(serverUrl, screenName);
    let freshProfile = false;
    if (!profile) {
      profile = profiles.addProfile(screenName, false, serverUrl);
      freshProfile = true;
    }

    try {
      const keystorePath = path.join(profiles.profileDir(profile.id), 'keystore.bin');
      // Download keystore if not cached locally (new device).
      if (!existsSync(keystorePath)) {
        const baseUrl = wssToHttps(serverUrl);
        const data = await hiveGet<{ encryptedKeystoreB64: string }>(
          baseUrl + `/api/users/${encodeURIComponent(screenName)}/keystore`,
        );
        const blob = Buffer.from(data.encryptedKeystoreB64, 'base64');
        await mkdir(path.dirname(keystorePath), { recursive: true });
        await writeFile(keystorePath, blob, { mode: 0o600 });
      }

      const r = await session.unlock(profile.id, passphrase);
      return { ok: true as const, profileId: r.profileId, buddyCode: r.buddyCode };
    } catch (err) {
      // If we created a fresh profile and unlock failed, roll it back so the
      // user can retry without accumulating stale profile entries.
      if (freshProfile) profiles.removeProfile(profile.id);
      throw err;
    }
  });

  // ── Buzz Mesh debug ───────────────────────────────────────────────────────
  handle(IPC.MeshDebugGet, null, async () => {
    const { MeshNode } = await import('../p2p/mesh.js');
    const netCfg = loadNetworkConfig();
    const status = MeshNode.instance.status;
    const tailnetPeers = await MeshNode.instance.fetchTailnetPeers().catch(() => [] as string[]);
    const conns = session.node ? session.node.getConnections() : [];
    const peerMap = new Map<string, string[]>();
    for (const c of conns) {
      const id = c.remotePeer.toString();
      const list = peerMap.get(id) ?? [];
      list.push(c.remoteAddr.toString());
      peerMap.set(id, list);
    }
    const pending = session.db
      ? (
          session.db
            .prepare("SELECT COUNT(*) as c FROM buddy_requests WHERE direction='out'")
            .get() as { c: number }
        ).c
      : 0;
    return {
      mode: netCfg.mode,
      meshState: status.state,
      meshIp: status.state === 'connected' ? (status as { ip: string }).ip : null,
      meshError: status.state === 'error' ? (status as { message: string }).message : null,
      socksPort: MeshNode.instance.socksPort,
      tailnetPeers,
      libp2pPeers: Array.from(peerMap.entries()).map(([peerId, addrs]) => ({ peerId, addrs })),
      pendingOutRequests: pending,
      dialErrors: session.meshDialErrors,
    };
  });
}

function requireDb(s: Session) {
  if (!s.db) throw new Error('Locked');
  return s.db;
}

// ── Hive HTTP helpers ─────────────────────────────────────────────────────────

/** Convert a wss:// or ws:// server URL to https:// or http:// for REST calls. */
function wssToHttps(serverUrl: string): string {
  return serverUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
}

/** GET a JSON endpoint on a Hive server. Accepts self-signed TLS certs. */
function hiveGet<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const lib: typeof https = url.startsWith('https') ? https : (http as unknown as typeof https);
    const options = { rejectUnauthorized: false };
    lib.get(url, options, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as T & { error?: string; message?: string };
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error((parsed as { message?: string }).message ?? `HTTP ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Invalid JSON response from server`));
        }
      });
    }).on('error', reject);
  });
}

/** POST JSON to a Hive server endpoint. Throws on non-2xx response. */
function hivePost(url: string, body: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib: typeof https = url.startsWith('https') ? https : (http as unknown as typeof https);
    const bodyStr = JSON.stringify(body);
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (url.startsWith('https') ? 443 : 80),
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
        rejectUnauthorized: false,
      },
      (res) => {
        let respBody = '';
        res.on('data', (chunk: Buffer) => { respBody += chunk.toString('utf8'); });
        res.on('end', () => {
          try {
            const parsed2 = JSON.parse(respBody) as { error?: string; message?: string };
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(parsed2.message ?? `HTTP ${res.statusCode}: ${parsed2.error ?? 'error'}`));
            } else {
              resolve();
            }
          } catch {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}`));
            } else {
              resolve();
            }
          }
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}
