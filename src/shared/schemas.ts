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

export const ServerRegisterReq = z.object({
  serverUrl: z.string().max(512),
  screenName: ScreenName,
  passphrase: Passphrase,
});
export type ServerRegisterReq = z.infer<typeof ServerRegisterReq>;

export const ServerUnlockReq = z.object({
  serverUrl: z.string().max(512),
  screenName: z.string().min(1).max(64),
  passphrase: Passphrase,
});
export type ServerUnlockReq = z.infer<typeof ServerUnlockReq>;

export const ProfileSummary = z.object({
  id: Uuid,
  screenName: z.string().min(1).max(64),
  createdAt: z.number().int().nonnegative(),
  mesh: z.boolean().default(false),
  /** Set for profiles tied to a Hive server account (the wss:// URL). Absent for local p2p/mesh profiles. */
  serverUrl: z.string().max(512).optional(),
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
  editedAt: z.number().int().nonnegative().optional(),
  deletedAt: z.number().int().nonnegative().optional(),
});
export type ImMessage = z.infer<typeof ImMessage>;

export const HistoryReq = z.object({
  peerId: PeerIdStr,
  limit: z.number().int().positive().max(500).default(100),
  before: z.number().int().nonnegative().optional(),
});
export type HistoryReq = z.infer<typeof HistoryReq>;

export const ImEditReq = z.object({
  id: Uuid,
  body: z.string().min(1).max(64 * 1024),
});
export type ImEditReq = z.infer<typeof ImEditReq>;

export const ImDeleteReq = z.object({ id: Uuid });
export type ImDeleteReq = z.infer<typeof ImDeleteReq>;

export const ImReactReq = z.object({
  msgId: Uuid,
  peerId: PeerIdStr,
  emoji: z.string().min(1).max(8),
});
export type ImReactReq = z.infer<typeof ImReactReq>;

export const ImUnreactReq = z.object({
  msgId: Uuid,
  peerId: PeerIdStr,
  emoji: z.string().min(1).max(8),
});
export type ImUnreactReq = z.infer<typeof ImUnreactReq>;

export const ImSearchReq = z.object({
  query: z.string().min(1).max(256),
  peerId: PeerIdStr.optional(),
  limit: z.number().int().positive().max(200).default(50),
});
export type ImSearchReq = z.infer<typeof ImSearchReq>;

export const Reaction = z.object({
  msgId: Uuid,
  peerId: PeerIdStr,
  emoji: z.string().min(1).max(8),
  ts: z.number().int().nonnegative(),
});
export type Reaction = z.infer<typeof Reaction>;

// ── Prefs ────────────────────────────────────────────────────────────────────

// Caps for embedded data URLs in the profile broadcast. The total profile
// frame must stay well below the 256 KiB IM frame cap, so we limit avatar
// and background image bytes individually.
const AVATAR_MAX = 96_000; // ~64 KB binary
const BG_IMAGE_MAX = 200_000; // ~128 KB binary
const imageDataUrl = (max: number) => z.string().max(max).refine(
  (value) => value === '' || /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(value),
  'Expected an image data URL',
);

export const Profile = z.object({
  aboutText: z.string().max(2000).default(''),
  textColor: z.string().max(32).default('#000000'),
  bgColor: z.string().max(32).default('#ffffff'),
  fontFamily: z.string().max(64).default(''),
  avatarDataUrl: imageDataUrl(AVATAR_MAX).default(''),
  bgImageDataUrl: imageDataUrl(BG_IMAGE_MAX).default(''),
});
export type Profile = z.infer<typeof Profile>;

// Look-and-feel knobs for the local client. None of these are broadcast to
// peers — they only affect how this user sees their own windows.
export const ChatTheme = z.enum(['classic', 'balloons', 'compact']);
export type ChatTheme = z.infer<typeof ChatTheme>;
export const WindowTheme = z.enum(['classic', 'aqua', 'graphite', 'aero', 'metal']);
export type WindowTheme = z.infer<typeof WindowTheme>;

export const Theme = z.object({
  chatTheme: ChatTheme.default('classic'),
  windowTheme: WindowTheme.default('classic'),
  colorMode: z.enum(['light', 'dark']).default('light'),
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
  soundScheme: z.enum(['buzz', 'classic']).default('buzz'),
  // Persisted base status across sessions. Only 'online' or 'invisible'
  // are persisted; 'away'/'idle' are derived/transient.
  lastStatus: z.enum(['online', 'invisible']).default('online'),
  // Desktop notifications
  notificationsEnabled: z.boolean().default(true),
  // Audio device & voice settings
  micDeviceId: z.string().max(256).default(''),
  speakerDeviceId: z.string().max(256).default(''),
  inputGain: z.number().min(0).max(4).default(1),
  outputGain: z.number().min(0).max(4).default(1),
  pttKey: z.string().max(64).default('b'),
  noiseSuppression: z.boolean().default(true),
  echoCancellation: z.boolean().default(true),
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
    colorMode: 'light',
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

// WSS URL for Hive server mode, e.g. wss://hive.example.com:7700
const WssUrl = z
  .string()
  .max(512)
  .regex(/^wss?:\/\/.+/, 'Must be a wss:// or ws:// URL');

export const NetworkConfig = z
  .object({
    mode: z.enum(['p2p', 'server', 'exp-p2p']).default('p2p'),
    // Legacy libp2p multiaddr (kept for backward compat, unused in server mode).
    serverAddr: z.string().max(512).default(''),
    // Hive server mode: WSS URL (e.g. wss://localhost:7700)
    serverUrl: z.string().max(512).default(''),
    // Whether to cache messages locally when in server mode.
    serverCacheEnabled: z.boolean().default(true),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.mode === 'server') {
      const r = WssUrl.safeParse(cfg.serverUrl);
      if (!r.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['serverUrl'],
          message: r.error.issues[0]?.message ?? 'Invalid server URL',
        });
      }
    }
  });
export type NetworkConfig = z.infer<typeof NetworkConfig>;

// ── Connection health ───────────────────────────────────────────────────────

export const HealthState = z.enum(['offline', 'connecting', 'online', 'degraded', 'error']);
export type HealthState = z.infer<typeof HealthState>;

export const TransportHealth = z.object({
  state: HealthState,
  label: z.string().min(1).max(64),
  detail: z.string().max(256).optional(),
  count: z.number().int().nonnegative().optional(),
  lastOkAt: z.number().int().nonnegative().optional(),
});
export type TransportHealth = z.infer<typeof TransportHealth>;

export const ConnectionHealth = z.object({
  mode: z.enum(['p2p', 'server', 'exp-p2p']),
  locked: z.boolean(),
  summary: HealthState,
  updatedAt: z.number().int().nonnegative(),
  p2p: TransportHealth,
  hive: TransportHealth,
  mesh: TransportHealth,
  mailbox: TransportHealth,
  call: TransportHealth,
  roomVoice: TransportHealth,
});
export type ConnectionHealth = z.infer<typeof ConnectionHealth>;

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
  ownerPeerId: z.string().max(512).default(''),
  mods: z.array(PeerIdStr).default([]),
});
export type Room = z.infer<typeof Room>;

// Discord-style channels within a room. Members all see every channel;
// channels share the room's symmetric key (the channel id is just metadata).
// 'text' channels carry chat messages; 'voice' channels are persistent audio
// rooms that any subset of members can join at any time.
const ChannelName = z.string().min(1).max(64).regex(/^[A-Za-z0-9 _-]+$/);
export const ChannelKind = z.enum(['text', 'voice']);
export type ChannelKind = z.infer<typeof ChannelKind>;
export const RoomChannel = z.object({
  id: Uuid,
  roomId: RoomId,
  name: ChannelName,
  kind: ChannelKind.default('text'),
  isDefault: z.boolean().default(false),
  createdAt: z.number().int().nonnegative(),
  category: z.string().max(64).default(''),
});
export type RoomChannel = z.infer<typeof RoomChannel>;

export const RoomChannelCreateReq = z.object({
  roomId: RoomId,
  name: ChannelName,
  kind: ChannelKind.default('text'),
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

// ── Voice channels ───────────────────────────────────────────────────────────

export const RoomVoiceJoinReq = z.object({ roomId: RoomId, channelId: Uuid });
export type RoomVoiceJoinReq = z.infer<typeof RoomVoiceJoinReq>;
export const RoomVoiceLeaveReq = z.object({ roomId: RoomId, channelId: Uuid });
export type RoomVoiceLeaveReq = z.infer<typeof RoomVoiceLeaveReq>;
// Audio chunks travel as raw bytes; we don't validate the byte length
// strictly here (handler caps it).
export const RoomVoiceAudioReq = z.object({
  roomId: RoomId,
  channelId: Uuid,
});
export type RoomVoiceAudioReq = z.infer<typeof RoomVoiceAudioReq>;
export const RoomVoicePresenceEvent = z.object({
  roomId: RoomId,
  channelId: Uuid,
  peerId: PeerIdStr,
  screenName: z.string().max(64).default(''),
  joined: z.boolean(),
});
export type RoomVoicePresenceEvent = z.infer<typeof RoomVoicePresenceEvent>;
export const RoomVoiceAudioEvent = z.object({
  roomId: RoomId,
  channelId: Uuid,
  peerId: PeerIdStr,
  screenName: z.string().max(64).default(''),
  data: z.instanceof(Uint8Array),
});
export type RoomVoiceAudioEvent = z.infer<typeof RoomVoiceAudioEvent>;

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
  replyToId: z.string().uuid().optional(),
  mentions: z.array(PeerIdStr).optional(),
  isPinned: z.boolean().optional(),
  editedAt: z.number().int().nonnegative().optional(),
  deletedAt: z.number().int().nonnegative().optional(),
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
  replyToId: z.string().uuid().optional(),
  mentions: z.array(PeerIdStr).optional(),
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

// ── Room moderation (v0.6.0) ─────────────────────────────────────────────────

export const RoomMember = z.object({
  peerId: PeerIdStr,
  role: z.enum(['owner', 'mod', 'member']),
});
export type RoomMember = z.infer<typeof RoomMember>;

export const RoomPinReq = z.object({
  roomId: RoomId,
  msgId: Uuid,
  isPinned: z.boolean(),
});
export type RoomPinReq = z.infer<typeof RoomPinReq>;

export const RoomKickReq = z.object({
  roomId: RoomId,
  peerId: PeerIdStr,
});
export type RoomKickReq = z.infer<typeof RoomKickReq>;

export const RoomSetRoleReq = z.object({
  roomId: RoomId,
  peerId: PeerIdStr,
  role: z.enum(['mod', 'member']),
});
export type RoomSetRoleReq = z.infer<typeof RoomSetRoleReq>;

export const RoomSetCategoryReq = z.object({
  roomId: RoomId,
  channelId: Uuid,
  category: z.string().max(64),
});
export type RoomSetCategoryReq = z.infer<typeof RoomSetCategoryReq>;

// v0.7.0 message action requests
export const RoomReactReq = z.object({ roomId: RoomId, msgId: Uuid, emoji: z.string().min(1).max(8) });
export type RoomReactReq = z.infer<typeof RoomReactReq>;
export const RoomUnreactReq = z.object({ roomId: RoomId, msgId: Uuid, emoji: z.string().min(1).max(8) });
export type RoomUnreactReq = z.infer<typeof RoomUnreactReq>;
export const RoomEditMsgReq = z.object({ roomId: RoomId, msgId: Uuid, body: z.string().min(1).max(64 * 1024) });
export type RoomEditMsgReq = z.infer<typeof RoomEditMsgReq>;
export const RoomDeleteMsgReq = z.object({ roomId: RoomId, msgId: Uuid });
export type RoomDeleteMsgReq = z.infer<typeof RoomDeleteMsgReq>;

export const RoomPinEvent = z.object({
  roomId: RoomId,
  msgId: Uuid,
  isPinned: z.boolean(),
});
export type RoomPinEvent = z.infer<typeof RoomPinEvent>;

export const RoomKickEvent = z.object({
  roomId: RoomId,
  peerId: PeerIdStr,
});
export type RoomKickEvent = z.infer<typeof RoomKickEvent>;

export const RoomRoleEvent = z.object({
  roomId: RoomId,
  peerId: PeerIdStr,
  role: z.enum(['owner', 'mod', 'member']),
});
export type RoomRoleEvent = z.infer<typeof RoomRoleEvent>;

export const RoomCategoryEvent = z.object({
  roomId: RoomId,
  channelId: Uuid,
  category: z.string().max(64),
});
export type RoomCategoryEvent = z.infer<typeof RoomCategoryEvent>;

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

// ── Buddy add requests (approve/deny) ────────────────────────────────────────

export const BuddyRequest = z.object({
  peerId: PeerIdStr,
  direction: z.enum(['in', 'out']),
  screenName: z.string().max(64).default(''),
  ts: z.number().int().nonnegative(),
});
export type BuddyRequest = z.infer<typeof BuddyRequest>;

export const BuddyRequestSendReq = z.object({
  buddyCode: BuddyCode,
  alias: z.string().min(1).max(64),
  group: z.string().min(1).max(32).default('Buddies'),
});
export type BuddyRequestSendReq = z.infer<typeof BuddyRequestSendReq>;

export const BuddyRequestEvent = z.object({
  kind: z.enum(['incoming', 'cancelled']),
  request: BuddyRequest,
});
export type BuddyRequestEvent = z.infer<typeof BuddyRequestEvent>;

// Sent to the requester after the recipient approves or (soft-)denies.
export const BuddyRequestResolvedEvent = z.object({
  peerId: PeerIdStr,
  accepted: z.boolean(),
});
export type BuddyRequestResolvedEvent = z.infer<typeof BuddyRequestResolvedEvent>;

// ── Unread counts ────────────────────────────────────────────────────────────

export const UnreadCounts = z.object({
  // Per-peer 1:1 IM unread (delivered but not yet shown in an open IM window).
  peers: z.record(PeerIdStr, z.number().int().nonnegative()),
  // Per-room unread (any message strictly newer than our last_seen watermark).
  rooms: z.record(Uuid, z.number().int().nonnegative()),
});
export type UnreadCounts = z.infer<typeof UnreadCounts>;

// ── Voice talk ───────────────────────────────────────────────────────────────

export const TalkInviteReq = z.object({ peerId: PeerIdStr, kind: z.enum(['voice', 'video']).optional() });
export type TalkInviteReq = z.infer<typeof TalkInviteReq>;

export const TalkCallIdReq = z.object({ callId: Uuid });
export type TalkCallIdReq = z.infer<typeof TalkCallIdReq>;

export const TalkAudioReq = z.object({
  callId: Uuid,
  data: z.instanceof(Uint8Array),
});
export type TalkAudioReq = z.infer<typeof TalkAudioReq>;

// State the renderer cares about for a single active call.
export const TalkCallState = z.object({
  callId: Uuid,
  peerId: PeerIdStr,
  role: z.enum(['caller', 'callee']),
  state: z.enum(['inviting', 'ringing', 'active', 'ended']),
  kind: z.enum(['voice', 'video']).default('voice'),
  screenName: z.string().optional(),
  startedAt: z.number().int().nonnegative().optional(),
});
export type TalkCallState = z.infer<typeof TalkCallState>;

export const TalkInviteEvent = TalkCallState;
export type TalkInviteEvent = z.infer<typeof TalkInviteEvent>;

export const TalkStateEvent = TalkCallState;
export type TalkStateEvent = z.infer<typeof TalkStateEvent>;

export const TalkEndedEvent = z.object({
  callId: Uuid,
  peerId: PeerIdStr,
  reason: z.string().optional(),
});
export type TalkEndedEvent = z.infer<typeof TalkEndedEvent>;

export const TalkAudioEvent = z.object({
  callId: Uuid,
  peerId: PeerIdStr,
  seq: z.number().int().nonnegative(),
  data: z.instanceof(Uint8Array),
});
export type TalkAudioEvent = z.infer<typeof TalkAudioEvent>;

export const TalkVideoReq = z.object({
  callId: Uuid,
  data: z.instanceof(Uint8Array),
});
export type TalkVideoReq = z.infer<typeof TalkVideoReq>;

export const TalkVideoStateReq = z.object({
  callId: Uuid,
  on: z.boolean(),
});
export type TalkVideoStateReq = z.infer<typeof TalkVideoStateReq>;

export const TalkVideoEvent = z.object({
  callId: Uuid,
  peerId: PeerIdStr,
  seq: z.number().int().nonnegative(),
  data: z.instanceof(Uint8Array),
});
export type TalkVideoEvent = z.infer<typeof TalkVideoEvent>;

export const TalkVideoStateEvent = z.object({
  callId: Uuid,
  peerId: PeerIdStr,
  on: z.boolean(),
});
export type TalkVideoStateEvent = z.infer<typeof TalkVideoStateEvent>;
