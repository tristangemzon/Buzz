import { app, desktopCapturer, dialog, ipcMain, BrowserWindow } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z, type ZodTypeAny } from 'zod';

import { IPC } from '@shared/ipc.js';
import {
  AddBuddyReq,
  BuddyRequestSendReq,
  CreateIdentityReq,
  HistoryReq,
  ImMessage,
  ImEditReq,
  ImDeleteReq,
  ImReactReq,
  ImUnreactReq,
  ImSearchReq,
  PeerIdStr,
  Prefs,
  Profile,
  PresenceSetStatusReq,
  RoomCreateReq,
  RoomHistoryReq,
  RoomInviteReq,
  RoomKickReq,
  RoomLeaveReq,
  RoomPinReq,
  RoomSendReq,
  RoomSetCategoryReq,
  RoomSetRoleReq,
  RoomChannelsListReq,
  RoomChannelCreateReq,
  RoomChannelDeleteReq,
  RoomVoiceJoinReq,
  RoomVoiceLeaveReq,
  RoomReactReq,
  RoomUnreactReq,
  RoomEditMsgReq,
  RoomDeleteMsgReq,
  TalkScreenStateReq,
  MailboxAddRelayReq,
  MailboxRemoveRelayReq,
  NetworkConfig,
  SendImReq,
  SetPrefsReq,
  UnlockReq,
  Uuid,
  XferOfferReq,
  XferRespondReq,
} from '@shared/schemas.js';
import type { Platform } from '@shared/types.js';

import * as repos from '../db/repos.js';
import { sodium } from '../crypto/keystore.js';
import { loadNetworkConfig, saveNetworkConfig } from '../network.js';
import { setNotificationsEnabled } from '../notify.js';
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
  handle(
    IPC.BuddiesMute,
    z.object({ peerId: PeerIdStr, muted: z.boolean() }),
    ({ peerId, muted }) => repos.setBuddyMuted(requireDb(session), peerId, muted),
  );

  // ── auto-discovery ────────────────────────────────────────────────────────
  handle(IPC.DiscoveryList, null, () => session.listDiscovered());

  // ── im ────────────────────────────────────────────────────────────────────
  handle(IPC.ImSend, SendImReq, async ({ toPeerId, body }) => {
    const db = requireDb(session);
    const im = session.im;
    const hive = session.hiveClient;
    if (!im && !hive) throw new Error('Locked');
    const msg: ImMessage = ImMessage.parse({
      id: randomUUID(),
      peerId: toPeerId,
      direction: 'out',
      ts: Date.now(),
      body,
      status: 'queued',
    });
    repos.insertMessage(db, msg);
    if (im) {
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
    } else if (hive) {
      const cipherB64 = hive.sealMessage(toPeerId, msg.body);
      if (!cipherB64) {
        repos.setMessageStatus(db, msg.id, 'failed');
        throw new Error('Cannot seal message: recipient public key unknown');
      }
      hive.sendIm(toPeerId, msg.id, msg.ts, cipherB64);
      msg.status = 'sent';
      repos.setMessageStatus(db, msg.id, 'sent');
    }
    return msg;
  });
  handle(IPC.ImHistory, HistoryReq, ({ peerId, limit, before }) =>
    repos.history(requireDb(session), peerId, limit, before),
  );
  handle(IPC.ImMarkRead, PeerIdStr, (peerId) => {
    const db = requireDb(session);
    const changed = repos.markImRead(db, peerId);
    if (changed > 0) session.broadcastUnread();
    // In server mode, send a read receipt for the most recent inbound message.
    if (session.hiveClient && changed > 0) {
      const latest = db.prepare(
        `SELECT id FROM messages WHERE peer_id=? AND direction='in' ORDER BY ts DESC LIMIT 1`,
      ).get(peerId) as { id: string } | undefined;
      if (latest) session.hiveClient.sendReadReceipt(peerId, latest.id);
    }
  });
  handle(IPC.UnreadGet, null, () => session.unreadSnapshot());

  handle(IPC.ImSendTyping, z.object({ toPeerId: PeerIdStr, typing: z.boolean() }), ({ toPeerId, typing }) => {
    if (session.im) {
      void session.im.send(toPeerId, { type: 'typing', typing }).catch(() => undefined);
    } else if (session.hiveClient) {
      session.hiveClient.sendTyping(toPeerId, typing);
    }
  });

  handle(IPC.ImEdit, ImEditReq, ({ id, body }) => {
    const db = requireDb(session);
    const editedAt = Date.now();
    repos.editMessage(db, id, body, editedAt);
    const row = db.prepare('SELECT peer_id FROM messages WHERE id=?').get(id) as { peer_id: string } | undefined;
    const evt = { id, body, editedAt };
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.EvtImEdited, evt);
    }
    if (session.hiveClient && row) {
      const cipherB64 = session.hiveClient.sealMessage(row.peer_id, body);
      if (cipherB64) session.hiveClient.sendEditMsg(row.peer_id, id, editedAt, cipherB64);
    }
    return { ok: true as const, editedAt, peerId: row?.peer_id };
  });

  handle(IPC.ImDelete, ImDeleteReq, ({ id }) => {
    const db = requireDb(session);
    const deletedAt = Date.now();
    const row = db.prepare('SELECT peer_id FROM messages WHERE id=?').get(id) as { peer_id: string } | undefined;
    repos.deleteMessage(db, id, deletedAt);
    const evt = { id, deletedAt };
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.EvtImDeleted, evt);
    }
    if (session.hiveClient && row) {
      session.hiveClient.sendDeleteMsg(row.peer_id, id, deletedAt);
    }
    return { ok: true as const, deletedAt };
  });

  handle(IPC.ImReact, ImReactReq, ({ msgId, peerId, emoji }) => {
    const db = requireDb(session);
    repos.upsertReaction(db, msgId, peerId, emoji);
    const evt = { msgId, peerId, emoji, added: true };
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.EvtReaction, evt);
    }
    // In server mode, send reaction to the other party.
    if (session.hiveClient) {
      const row = db.prepare('SELECT peer_id FROM messages WHERE id=?').get(msgId) as { peer_id: string } | undefined;
      if (row) session.hiveClient.sendReaction(row.peer_id, msgId, emoji);
    }
    return { ok: true as const };
  });

  handle(IPC.ImUnreact, ImUnreactReq, ({ msgId, peerId, emoji }) => {
    const db = requireDb(session);
    repos.deleteReaction(db, msgId, peerId, emoji);
    const evt = { msgId, peerId, emoji, added: false };
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.EvtReaction, evt);
    }
    if (session.hiveClient) {
      const row = db.prepare('SELECT peer_id FROM messages WHERE id=?').get(msgId) as { peer_id: string } | undefined;
      if (row) session.hiveClient.sendUnreaction(row.peer_id, msgId, emoji);
    }
    return { ok: true as const };
  });

  handle(IPC.ImListReactions, z.object({ msgIds: z.array(Uuid).max(200) }), ({ msgIds }) => {
    const db = requireDb(session);
    return repos.listReactionsForMessages(db, msgIds);
  });

  handle(IPC.ImSearch, ImSearchReq, ({ query, peerId, limit }) => {
    const db = requireDb(session);
    // Simple LIKE search over stored message bodies.
    const likeQuery = `%${query.replace(/[%_]/g, '\\$&')}%`;
    const rows = peerId
      ? (db.prepare(
          `SELECT id, peer_id as peerId, direction, ts, body, status, edited_at as editedAt, deleted_at as deletedAt
           FROM messages WHERE peer_id=? AND body LIKE ? ESCAPE '\\' AND deleted_at IS NULL ORDER BY ts DESC LIMIT ?`,
        ).all(peerId, likeQuery, limit))
      : (db.prepare(
          `SELECT id, peer_id as peerId, direction, ts, body, status, edited_at as editedAt, deleted_at as deletedAt
           FROM messages WHERE body LIKE ? ESCAPE '\\' AND deleted_at IS NULL ORDER BY ts DESC LIMIT ?`,
        ).all(likeQuery, limit));
    return rows as ImMessage[];
  });

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
    // Keep notification gate in sync.
    if (patch.notificationsEnabled !== undefined) {
      setNotificationsEnabled(patch.notificationsEnabled);
    }
    return updated;
  });

  // ── network mode (pre-unlock readable) ───────────────────────────────────
  handle(IPC.NetworkGet, null, () => loadNetworkConfig());
  handle(IPC.NetworkSet, NetworkConfig, (cfg) => saveNetworkConfig(cfg));

  // ── connection health ────────────────────────────────────────────────────
  handle(IPC.HealthGet, null, () => session.connectionHealth());

  // ── presence ─────────────────────────────────────────────────────────────────────────────────────────
  handle(IPC.PresenceSetStatus, PresenceSetStatusReq, async ({ status, awayMessage }) => {
    const p = session.presence;
    if (!p) throw new Error('Locked');
    // Persist away message text into prefs when provided so it survives
    // restarts and can be edited from Preferences later.
    if (status === 'away' && typeof awayMessage === 'string') {
      repos.setPrefs(requireDb(session), { awayMessage });
    }
    return p.setStatus(status, awayMessage);
  });
  handle(IPC.PresenceGetSelf, null, () => {
    const p = session.presence;
    if (!p) throw new Error('Locked');
    return p.getSelf();
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
  // Media chunks: fire-and-forget on a separate ipcMain.on. No return value,
  // raw bytes — avoids a Promise round-trip per ~80ms timeslice. Backpressure
  // and drop policy are enforced in TalkService.send().
  ipcMain.on(
    IPC.TalkAudio,
    (_e, payload: { callId: string }, data: Uint8Array) => {
      if (typeof payload?.callId === 'string' && data instanceof Uint8Array) {
        void session.sendCallAudio(payload.callId, data);
      }
    },
  );
  ipcMain.on(
    IPC.TalkVideo,
    (_e, payload: { callId: string }, data: Uint8Array) => {
      if (typeof payload?.callId === 'string' && data instanceof Uint8Array) {
        void session.sendCallVideo(payload.callId, data);
      }
    },
  );
  ipcMain.on(
    IPC.TalkScreen,
    (_e, payload: { callId: string }, data: Uint8Array) => {
      if (typeof payload?.callId === 'string' && data instanceof Uint8Array) {
        void session.sendCallScreen(payload.callId, data);
      }
    },
  );
  handle(
    IPC.TalkVideoState,
    z.object({ callId: Uuid, on: z.boolean() }),
    async ({ callId, on }) => {
      await session.setCallVideo(callId, on);
    },
  );
  handle(IPC.TalkScreenSources, null, async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 220, height: 140 },
      fetchWindowIcons: false,
    });
    return {
      sources: sources.map((source) => ({
        id: source.id,
        name: source.name,
        kind: source.id.startsWith('screen:') ? 'screen' as const : 'window' as const,
        thumbnailDataUrl: source.thumbnail.isEmpty() ? undefined : source.thumbnail.toDataURL(),
      })),
    };
  });
  handle(IPC.TalkScreenState, TalkScreenStateReq, async ({ callId, on, sourceName, resolution }) => {
    await session.setCallScreen(callId, on, sourceName, resolution);
  });
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
    const myPeerId = session.peerIdStr();
    const { roomId, keyB64, members: full } = await rooms.createRoom({
      name,
      members,
      ownerPeerId: myPeerId,
      channels: [defaultChannel],
    });
    repos.upsertRoom(db, { id: roomId, name, keyB64, createdAt, ownerPeerId: myPeerId });
    repos.setRoomMembers(db, roomId, full);
    repos.setMemberRole(db, roomId, myPeerId, 'owner');
    repos.upsertRoomChannel(db, { ...defaultChannel, roomId, category: '' });
    const s = await sodium();
    session.cacheRoomKey(roomId, s.from_base64(keyB64, s.base64_variants.ORIGINAL));
    session.cacheRoomMembers(roomId, full);
    return { id: roomId, name, members: full, createdAt, ownerPeerId: myPeerId, mods: [] };
  });
  handle(IPC.RoomsInvite, RoomInviteReq, async ({ roomId, peerId }) => {
    const db = requireDb(session);
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
    const members = await rooms.invite(roomId, peerId, room.name, channels, room.ownerPeerId);
    repos.setRoomMembers(db, roomId, members);
    session.cacheRoomMembers(roomId, members);
    return { id: roomId, name: room.name, members, createdAt: room.createdAt, ownerPeerId: room.ownerPeerId, mods: room.mods };
  });
  handle(IPC.RoomsLeave, RoomLeaveReq, async ({ roomId }) => {
    const db = requireDb(session);
    const rooms = session.rooms;
    if (!rooms) throw new Error('Locked');
    await rooms.leave(roomId);
    repos.deleteRoom(db, roomId);
    session.forgetRoom(roomId);
    return { ok: true as const };
  });
  handle(IPC.RoomsSend, RoomSendReq, async ({ roomId, channelId, body, replyToId, mentions }) => {
    const db = requireDb(session);
    const rooms = session.rooms;
    if (!rooms) throw new Error('Locked');
    // Validate the channel belongs to this room.
    const ch = repos.getRoomChannel(db, channelId);
    if (!ch || ch.roomId !== roomId) throw new Error('Unknown channel');
    const { id, ts } = await rooms.sendMessage(roomId, channelId, body, { replyToId, mentions });
    const stored = {
      id,
      roomId,
      channelId,
      fromPeerId: session.peerIdStr(),
      fromName: session.screenName,
      direction: 'out' as const,
      ts,
      body,
      replyToId,
      mentions,
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
      category: '',
    } as const;
    repos.upsertRoomChannel(db, ch);
    await rooms.broadcastChannelAdd(roomId, ch.id, ch.name, ch.kind);
    return ch;
  });
  handle(IPC.RoomsDeleteChannel, RoomChannelDeleteReq, async ({ roomId, channelId }) => {
    const db = requireDb(session);
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

  // ── v0.6.0 moderation handlers ─────────────────────────────────────────
  handle(IPC.RoomsPin, RoomPinReq, async ({ roomId, msgId, isPinned }) => {
    const db = requireDb(session);
    const rooms = session.rooms;
    const hive = session.hiveClient;
    if (!rooms && !hive) throw new Error('Locked');
    const myPeerId = session.peerIdStr();
    const room = repos.getRoom(db, roomId);
    if (!room) throw new Error('Unknown room');
    if (rooms) {
      const memberRows = repos.getRoomMembersWithRoles(db, roomId);
      const myRole = memberRows.find((m) => m.peerId === myPeerId)?.role ?? 'member';
      if (myRole === 'member') throw new Error('Insufficient permissions');
      repos.pinRoomMessage(db, msgId, isPinned);
      await rooms.broadcastPin(roomId, msgId, isPinned);
    } else {
      repos.pinRoomMessage(db, msgId, isPinned);
      hive!.sendRoomPin(roomId, msgId, isPinned);
    }
    return { ok: true as const };
  });

  handle(IPC.RoomsListPinned, z.object({ roomId: z.string(), channelId: z.string().uuid().optional() }), ({ roomId, channelId }) =>
    repos.listPinnedRoomMessages(requireDb(session), roomId, channelId),
  );

  handle(IPC.RoomsKick, RoomKickReq, async ({ roomId, peerId }) => {
    const db = requireDb(session);
    const rooms = session.rooms;
    const hive = session.hiveClient;
    if (!rooms && !hive) throw new Error('Locked');
    const myPeerId = session.peerIdStr();
    const room = repos.getRoom(db, roomId);
    if (!room) throw new Error('Unknown room');
    if (rooms) {
      const memberRows = repos.getRoomMembersWithRoles(db, roomId);
      const myRole = memberRows.find((m) => m.peerId === myPeerId)?.role ?? 'member';
      const targetRole = memberRows.find((m) => m.peerId === peerId)?.role ?? 'member';
      if (myRole === 'member') throw new Error('Insufficient permissions');
      if (myRole === 'mod' && (targetRole === 'mod' || targetRole === 'owner')) throw new Error('Insufficient permissions');
      repos.kickRoomMember(db, roomId, peerId);
      const members = repos.getRoomMembers(db, roomId);
      session.cacheRoomMembers(roomId, members);
      await rooms.broadcastKick(roomId, peerId);
    } else {
      repos.kickRoomMember(db, roomId, peerId);
      const members = repos.getRoomMembers(db, roomId);
      session.cacheRoomMembers(roomId, members);
      hive!.sendRoomKick(roomId, peerId);
    }
    return { ok: true as const };
  });

  handle(IPC.RoomsSetRole, RoomSetRoleReq, async ({ roomId, peerId, role }) => {
    const db = requireDb(session);
    const rooms = session.rooms;
    const hive = session.hiveClient;
    if (!rooms && !hive) throw new Error('Locked');
    const myPeerId = session.peerIdStr();
    const room = repos.getRoom(db, roomId);
    if (!room) throw new Error('Unknown room');
    // Only the owner can change roles.
    if (room.ownerPeerId !== myPeerId) throw new Error('Only the room owner can change roles');
    repos.setMemberRole(db, roomId, peerId, role);
    if (rooms) {
      await rooms.broadcastRole(roomId, peerId, role);
    } else {
      hive!.sendRoomRole(roomId, peerId, role);
    }
    return { ok: true as const };
  });

  handle(
    IPC.RoomsMute,
    z.object({ roomId: z.string().min(1), muted: z.boolean() }),
    ({ roomId, muted }) => repos.setRoomMuted(requireDb(session), roomId, muted),
  );

  handle(IPC.RoomsSetCategory, RoomSetCategoryReq, async ({ roomId, channelId, category }) => {
    const db = requireDb(session);
    const rooms = session.rooms;
    const hive = session.hiveClient;
    if (!rooms && !hive) throw new Error('Locked');
    const myPeerId = session.peerIdStr();
    const memberRows = repos.getRoomMembersWithRoles(db, roomId);
    const myRole = memberRows.find((m) => m.peerId === myPeerId)?.role ?? 'member';
    if (myRole === 'member') throw new Error('Insufficient permissions');
    const ch = repos.getRoomChannel(db, channelId);
    if (!ch || ch.roomId !== roomId) throw new Error('Unknown channel');
    repos.setChannelCategory(db, channelId, category);
    if (rooms) {
      await rooms.broadcastCategory(roomId, channelId, category);
    } else {
      hive!.sendRoomCategory(roomId, channelId, category);
    }
    return { ok: true as const };
  });

  // ── v0.7.0 room message actions ────────────────────────────────────────
  handle(IPC.RoomsReact, RoomReactReq, async ({ roomId, msgId, emoji }) => {
    const db = requireDb(session);
    const myPeerId = session.peerIdStr();
    repos.upsertReaction(db, msgId, myPeerId, emoji);
    const evt = { roomId, msgId, peerId: myPeerId, emoji, added: true };
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.EvtReaction, evt);
    }
    if (session.rooms) await session.rooms.broadcastReaction(roomId, msgId, emoji, true);
    else if (session.hiveClient) session.hiveClient.sendRoomReaction(roomId, msgId, emoji);
    return { ok: true as const };
  });

  handle(IPC.RoomsUnreact, RoomUnreactReq, async ({ roomId, msgId, emoji }) => {
    const db = requireDb(session);
    const myPeerId = session.peerIdStr();
    repos.deleteReaction(db, msgId, myPeerId, emoji);
    const evt = { roomId, msgId, peerId: myPeerId, emoji, added: false };
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.EvtReaction, evt);
    }
    if (session.rooms) await session.rooms.broadcastReaction(roomId, msgId, emoji, false);
    else if (session.hiveClient) session.hiveClient.sendRoomUnreaction(roomId, msgId, emoji);
    return { ok: true as const };
  });

  handle(IPC.RoomsEditMsg, RoomEditMsgReq, async ({ roomId, msgId, body }) => {
    const db = requireDb(session);
    const editedAt = Date.now();
    const changed = repos.editRoomMessage(db, msgId, body, editedAt);
    if (!changed) throw new Error('Message is no longer editable');
    const evt = { roomId, msgId, body, editedAt };
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.EvtRoomEdited, evt);
    }
    if (session.rooms) await session.rooms.broadcastEditMsg(roomId, msgId, body);
    else if (session.hiveClient) {
      const cipherB64 = await session.encryptHiveRoomBody(roomId, body);
      session.hiveClient.sendRoomEditMsg(roomId, msgId, editedAt, cipherB64);
    }
    return { ok: true as const };
  });

  handle(IPC.RoomsDeleteMsg, RoomDeleteMsgReq, async ({ roomId, msgId }) => {
    const db = requireDb(session);
    const deletedAt = Date.now();
    repos.deleteRoomMessage(db, msgId, deletedAt);
    const evt = { roomId, msgId, deletedAt };
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.EvtRoomDeleted, evt);
    }
    if (session.rooms) await session.rooms.broadcastDeleteMsg(roomId, msgId);
    else if (session.hiveClient) session.hiveClient.sendRoomDeleteMsg(roomId, msgId, deletedAt);
    return { ok: true as const };
  });

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
