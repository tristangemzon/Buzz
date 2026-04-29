import { z } from 'zod';

// ── Primitive validators ──────────────────────────────────────────────────────

// Base32 buddy code: PeerId encoded; we accept any non-empty <= 256 chars and
// defer canonical validation to the libp2p layer.
export const BuddyCode = z.string().min(8).max(512);
export const ScreenName = z.string().min(1).max(32).regex(/^[\w .'-]+$/);
export const Passphrase = z.string().min(8).max(1024);
export const PeerIdStr = z.string().min(8).max(512);
export const Uuid = z.string().uuid();

// ── Auth ─────────────────────────────────────────────────────────────────────

export const CreateIdentityReq = z.object({
  screenName: ScreenName,
  passphrase: Passphrase,
});
export type CreateIdentityReq = z.infer<typeof CreateIdentityReq>;

export const UnlockReq = z.object({
  profileId: Uuid,
  passphrase: Passphrase,
});
export type UnlockReq = z.infer<typeof UnlockReq>;

export const ProfileSummary = z.object({
  id: Uuid,
  screenName: z.string().min(1).max(64),
  createdAt: z.number().int().nonnegative(),
});
export type ProfileSummary = z.infer<typeof ProfileSummary>;

// ── Buddies ──────────────────────────────────────────────────────────────────

export const Status = z.enum(['online', 'away', 'idle', 'invisible', 'offline']);
export type Status = z.infer<typeof Status>;

export const Buddy = z.object({
  peerId: PeerIdStr,
  alias: z.string().min(1).max(64),
  group: z.string().min(1).max(32).default('Buddies'),
  blocked: z.boolean().default(false),
  warnLevel: z.number().int().min(0).max(100).default(0),
  status: Status.default('offline'),
  awayMessage: z.string().max(1024).optional(),
});
export type Buddy = z.infer<typeof Buddy>;

export const AddBuddyReq = z.object({
  buddyCode: BuddyCode,
  alias: z.string().min(1).max(64),
  group: z.string().min(1).max(32).default('Buddies'),
});
export type AddBuddyReq = z.infer<typeof AddBuddyReq>;

// ── IM ───────────────────────────────────────────────────────────────────────

export const SendImReq = z.object({
  toPeerId: PeerIdStr,
  body: z.string().min(1).max(64 * 1024),
});
export type SendImReq = z.infer<typeof SendImReq>;

export const ImMessage = z.object({
  id: Uuid,
  peerId: PeerIdStr,
  direction: z.enum(['in', 'out']),
  ts: z.number().int().nonnegative(),
  body: z.string(),
  status: z.enum(['queued', 'sent', 'delivered', 'read', 'failed']),
});
export type ImMessage = z.infer<typeof ImMessage>;

export const HistoryReq = z.object({
  peerId: PeerIdStr,
  limit: z.number().int().positive().max(500).default(100),
  before: z.number().int().nonnegative().optional(),
});
export type HistoryReq = z.infer<typeof HistoryReq>;

// ── Prefs ────────────────────────────────────────────────────────────────────

// Caps for embedded data URLs in the profile broadcast. The total profile
// frame must stay well below the 256 KiB IM frame cap, so we limit avatar
// and background image bytes individually.
const AVATAR_MAX = 96_000; // ~64 KB binary
const BG_IMAGE_MAX = 200_000; // ~128 KB binary

export const Profile = z.object({
  aboutText: z.string().max(2000).default(''),
  textColor: z.string().max(32).default('#000000'),
  bgColor: z.string().max(32).default('#ffffff'),
  fontFamily: z.string().max(64).default(''),
  avatarDataUrl: z.string().max(AVATAR_MAX).default(''),
  bgImageDataUrl: z.string().max(BG_IMAGE_MAX).default(''),
});
export type Profile = z.infer<typeof Profile>;

// Look-and-feel knobs for the local client. None of these are broadcast to
// peers — they only affect how this user sees their own windows.
export const ChatTheme = z.enum(['classic', 'balloons', 'compact']);
export type ChatTheme = z.infer<typeof ChatTheme>;
export const WindowTheme = z.enum(['classic', 'aqua', 'graphite']);
export type WindowTheme = z.infer<typeof WindowTheme>;

export const Theme = z.object({
  chatTheme: ChatTheme.default('classic'),
  windowTheme: WindowTheme.default('classic'),
  myBubbleColor: z.string().max(32).default('#d8f0ff'),
  theirBubbleColor: z.string().max(32).default('#eeeeee'),
  showTimestamps: z.boolean().default(true),
  showAvatarsInChat: z.boolean().default(true),
});
export type Theme = z.infer<typeof Theme>;

export const Prefs = z.object({
  skin: z.enum(['auto', 'mac', 'windows']).default('auto'),
  awayMessage: z.string().max(1024).default(''),
  idleMinutes: z.number().int().min(1).max(180).default(10),
  soundsEnabled: z.boolean().default(true),
  // Persisted base status across sessions. Only 'online' or 'invisible'
  // are persisted; 'away'/'idle' are derived/transient.
  lastStatus: z.enum(['online', 'invisible']).default('online'),
  profile: Profile.default({
    aboutText: '',
    textColor: '#000000',
    bgColor: '#ffffff',
    fontFamily: '',
    avatarDataUrl: '',
    bgImageDataUrl: '',
  }),
  theme: Theme.default({
    chatTheme: 'classic',
    windowTheme: 'classic',
    myBubbleColor: '#d8f0ff',
    theirBubbleColor: '#eeeeee',
    showTimestamps: true,
    showAvatarsInChat: true,
  }),
  // Offline mailbox relays (peer ids) — used as both push targets when a
  // direct send fails and as poll sources for envelopes addressed to us.
  mailboxRelays: z.array(PeerIdStr).max(8).default([]),
});
export type Prefs = z.infer<typeof Prefs>;

export const SetPrefsReq = Prefs.partial();
export type SetPrefsReq = z.infer<typeof SetPrefsReq>;

// ── Network mode (pre-unlock config) ────────────────────────────────────────
//
// Kept OUTSIDE encrypted prefs so it can be read before the user unlocks
// (the libp2p node needs it at bring-up time). It contains no secrets — only
// routing hints — so plaintext storage is fine.
//
// `serverAddr` is a libp2p multiaddr ending in `/p2p/<peerid>`, e.g.
//   /dns4/relay.example.com/tcp/4001/p2p/12D3KooW...
// or
//   /ip4/198.51.100.7/tcp/4001/p2p/12D3KooW...

// Loose multiaddr shape check; libp2p does the real validation.
const Multiaddr = z
  .string()
  .min(8)
  .max(512)
  .regex(/^\/[A-Za-z0-9._\-/]+\/p2p\/[A-Za-z0-9]+$/, 'Must be a multiaddr ending in /p2p/<peerid>');

export const NetworkConfig = z
  .object({
    mode: z.enum(['p2p', 'server']).default('p2p'),
    serverAddr: z.string().max(512).default(''),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.mode === 'server') {
      const r = Multiaddr.safeParse(cfg.serverAddr);
      if (!r.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['serverAddr'],
          message: r.error.issues[0]?.message ?? 'Invalid server address',
        });
      }
    }
  });
export type NetworkConfig = z.infer<typeof NetworkConfig>;

// ── Presence ─────────────────────────────────────────────────────────────────

// Only states the user can directly select. 'idle' is auto-derived from
// system idle time; 'offline' is implied by being locked / disconnected.
export const SelectableStatus = z.enum(['online', 'away', 'invisible']);
export type SelectableStatus = z.infer<typeof SelectableStatus>;

export const PresenceSetStatusReq = z.object({
  status: SelectableStatus,
  awayMessage: z.string().max(1024).optional(),
});
export type PresenceSetStatusReq = z.infer<typeof PresenceSetStatusReq>;

export const SelfPresence = z.object({
  status: Status,
  baseStatus: SelectableStatus,
  awayMessage: z.string().max(1024).optional(),
});
export type SelfPresence = z.infer<typeof SelfPresence>;

// ── Events ───────────────────────────────────────────────────────────────────

export const BuddyStatusEvent = z.object({
  peerId: PeerIdStr,
  status: Status,
  awayMessage: z.string().max(1024).optional(),
});
export type BuddyStatusEvent = z.infer<typeof BuddyStatusEvent>;

export const ImReceivedEvent = ImMessage;
export type ImReceivedEvent = ImMessage;

// ── Profile (peer cache) ─────────────────────────────────────────────────────

// What we cache locally for each peer that has broadcast their profile.
export const PeerProfile = z.object({
  peerId: PeerIdStr,
  screenName: z.string().min(0).max(64).default(''),
  aboutText: z.string().max(2000).default(''),
  textColor: z.string().max(32).default(''),
  bgColor: z.string().max(32).default(''),
  fontFamily: z.string().max(64).default(''),
  avatarDataUrl: z.string().max(200_000).default(''),
  bgImageDataUrl: z.string().max(400_000).default(''),
  lastSeen: z.number().int().nonnegative().default(0),
});
export type PeerProfile = z.infer<typeof PeerProfile>;

// ── File transfer ────────────────────────────────────────────────────────────

export const XferOfferReq = z.object({
  toPeerId: PeerIdStr,
});
export type XferOfferReq = z.infer<typeof XferOfferReq>;

export const XferRespondReq = z.object({
  id: Uuid,
  accept: z.boolean(),
});
export type XferRespondReq = z.infer<typeof XferRespondReq>;

export const XferOfferEvent = z.object({
  id: Uuid,
  peerId: PeerIdStr,
  fileName: z.string().min(1).max(256),
  fileSize: z.number().int().nonnegative(),
  hash: z.string().min(8).max(128),
});
export type XferOfferEvent = z.infer<typeof XferOfferEvent>;

export const XferProgressEvent = z.object({
  id: Uuid,
  peerId: PeerIdStr,
  direction: z.enum(['in', 'out']),
  bytes: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type XferProgressEvent = z.infer<typeof XferProgressEvent>;

export const XferDoneEvent = z.object({
  id: Uuid,
  peerId: PeerIdStr,
  direction: z.enum(['in', 'out']),
  fileName: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  savedPath: z.string().optional(),
});
export type XferDoneEvent = z.infer<typeof XferDoneEvent>;

export const ImAckEvent = z.object({
  id: Uuid,
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
});
export type ImAckEvent = z.infer<typeof ImAckEvent>;

// ── Chat rooms ───────────────────────────────────────────────────────────────

// Room name shown in the title bar; friendly rather than a UUID.
const RoomName = z.string().min(1).max(80);
const RoomId = Uuid;

// On-disk / over-wire shape of a chat room. The 32-byte symmetric key is
// base64'd and stays local; it is sealed to each invitee at invite time.
export const Room = z.object({
  id: RoomId,
  name: RoomName,
  members: z.array(PeerIdStr).min(1).max(64),
  createdAt: z.number().int().nonnegative(),
});
export type Room = z.infer<typeof Room>;

// Discord-style text channels within a room. Members all see every channel;
// channels share the room's symmetric key (the channel id is just metadata).
const ChannelName = z.string().min(1).max(64).regex(/^[A-Za-z0-9 _-]+$/);
export const RoomChannel = z.object({
  id: Uuid,
  roomId: RoomId,
  name: ChannelName,
  isDefault: z.boolean().default(false),
  createdAt: z.number().int().nonnegative(),
});
export type RoomChannel = z.infer<typeof RoomChannel>;

export const RoomChannelCreateReq = z.object({
  roomId: RoomId,
  name: ChannelName,
});
export type RoomChannelCreateReq = z.infer<typeof RoomChannelCreateReq>;

export const RoomChannelDeleteReq = z.object({
  roomId: RoomId,
  channelId: Uuid,
});
export type RoomChannelDeleteReq = z.infer<typeof RoomChannelDeleteReq>;

export const RoomChannelsListReq = z.object({ roomId: RoomId });
export type RoomChannelsListReq = z.infer<typeof RoomChannelsListReq>;

export const RoomChannelEvent = z.object({
  kind: z.enum(['added', 'removed']),
  channel: RoomChannel,
});
export type RoomChannelEvent = z.infer<typeof RoomChannelEvent>;

export const RoomMessage = z.object({
  id: Uuid,
  roomId: RoomId,
  channelId: Uuid,
  fromPeerId: PeerIdStr,
  fromName: z.string().max(64).default(''),
  ts: z.number().int().nonnegative(),
  body: z.string().max(64 * 1024),
  // 'in' if from another peer, 'out' if from us. Local convenience field.
  direction: z.enum(['in', 'out']),
});
export type RoomMessage = z.infer<typeof RoomMessage>;

export const RoomCreateReq = z.object({
  name: RoomName,
  members: z.array(PeerIdStr).min(1).max(63),
});
export type RoomCreateReq = z.infer<typeof RoomCreateReq>;

export const RoomInviteReq = z.object({
  roomId: RoomId,
  peerId: PeerIdStr,
});
export type RoomInviteReq = z.infer<typeof RoomInviteReq>;

export const RoomLeaveReq = z.object({ roomId: RoomId });
export type RoomLeaveReq = z.infer<typeof RoomLeaveReq>;

export const RoomSendReq = z.object({
  roomId: RoomId,
  channelId: Uuid,
  body: z.string().min(1).max(64 * 1024),
});
export type RoomSendReq = z.infer<typeof RoomSendReq>;

export const RoomHistoryReq = z.object({
  roomId: RoomId,
  channelId: Uuid.optional(),
  limit: z.number().int().positive().max(500).default(200),
  before: z.number().int().nonnegative().optional(),
});
export type RoomHistoryReq = z.infer<typeof RoomHistoryReq>;

// Events from main → renderer.
export const RoomMessageEvent = RoomMessage;
export type RoomMessageEvent = RoomMessage;

export const RoomInvitedEvent = z.object({
  roomId: RoomId,
  name: RoomName,
  fromPeerId: PeerIdStr,
  members: z.array(PeerIdStr),
});
export type RoomInvitedEvent = z.infer<typeof RoomInvitedEvent>;

export const RoomMembersEvent = z.object({
  roomId: RoomId,
  members: z.array(PeerIdStr),
});
export type RoomMembersEvent = z.infer<typeof RoomMembersEvent>;

// ── Offline mailbox relay ────────────────────────────────────────────────────

export const MailboxAddRelayReq = z.object({ peerId: PeerIdStr });
export type MailboxAddRelayReq = z.infer<typeof MailboxAddRelayReq>;

export const MailboxRemoveRelayReq = z.object({ peerId: PeerIdStr });
export type MailboxRemoveRelayReq = z.infer<typeof MailboxRemoveRelayReq>;

export const MailboxStats = z.object({
  // Number of envelopes currently held by us as a relay (for any recipient).
  relayHeldCount: z.number().int().nonnegative(),
  // Configured relays we push to / poll from.
  relays: z.array(PeerIdStr),
  // Last successful poll timestamp per relay (unix ms; 0 if never).
  lastPolledAt: z.record(PeerIdStr, z.number()),
});
export type MailboxStats = z.infer<typeof MailboxStats>;

export const MailboxDeliveredEvent = z.object({
  peerId: PeerIdStr,
  count: z.number().int().nonnegative(),
});
export type MailboxDeliveredEvent = z.infer<typeof MailboxDeliveredEvent>;

// ── Discovery ────────────────────────────────────────────────────────────────

// A peer auto-discovered on the LAN (mDNS) that speaks the Buzz IM protocol.
export const DiscoveredPeer = z.object({
  peerId: PeerIdStr,
  screenName: z.string().max(64).optional(),
  source: z.enum(['mdns']),
  lastSeen: z.number().int().nonnegative(),
});
export type DiscoveredPeer = z.infer<typeof DiscoveredPeer>;

export const DiscoveredEvent = z.object({
  kind: z.enum(['added', 'removed']),
  peer: DiscoveredPeer,
});
export type DiscoveredEvent = z.infer<typeof DiscoveredEvent>;
