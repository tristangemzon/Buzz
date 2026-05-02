import type {
  AddBuddyReq,
  Buddy,
  BuddyRequest,
  BuddyRequestEvent,
  BuddyRequestResolvedEvent,
  BuddyRequestSendReq,
  BuddyStatusEvent,
  CreateIdentityReq,
  DiscoveredEvent,
  DiscoveredPeer,
  HistoryReq,
  ImAckEvent,
  ImMessage,
  ImReceivedEvent,
  PeerProfile,
  Prefs,
  PresenceSetStatusReq,
  Profile,
  ProfileSummary,
  Room,
  RoomChannel,
  RoomChannelCreateReq,
  RoomChannelDeleteReq,
  RoomChannelEvent,
  RoomChannelsListReq,
  RoomVoiceJoinReq,
  RoomVoiceLeaveReq,
  RoomVoicePresenceEvent,
  RoomVoiceAudioEvent,
  RoomCreateReq,
  RoomHistoryReq,
  RoomInvitedEvent,
  RoomInviteReq,
  RoomLeaveReq,
  RoomMembersEvent,
  RoomMessage,
  RoomMessageEvent,
  RoomSendReq,
  MailboxAddRelayReq,
  MailboxDeliveredEvent,
  MailboxRemoveRelayReq,
  MailboxStats,
  NetworkConfig,
  SelfPresence,
  SendImReq,
  SetPrefsReq,
  ServerDiscoverResult,
  ServerRegisterReq,
  ServerUnlockReq,
  UnlockReq,
  UnreadCounts,
  XferDoneEvent,
  XferOfferEvent,
  XferProgressEvent,
  TalkCallState,
  TalkInviteEvent,
  TalkStateEvent,
  TalkEndedEvent,
  TalkAudioEvent,
  TalkVideoEvent,
  TalkVideoStateEvent,
  Theme,
} from './schemas.js';

export type Platform = 'mac' | 'windows' | 'linux';

// ── Games ─────────────────────────────────────────────────────────────────
export type GameKind = 'checkers' | 'chess' | 'reversi' | 'gomoku' | 'poker' | 'spades' | (string & {});

/** Checkers: 64-cell board, null = empty, 'r'/'b' = red/black man, 'R'/'B' = king. */
export type CheckersCell = null | 'r' | 'b' | 'R' | 'B';

export type GameInviteReq = {
  toPeerId: string;
  kind: GameKind;
};
export type GameMoveReq = {
  toPeerId: string;
  kind: GameKind;
  /** Sequence of board-index steps for the move (multi-jump = length > 2). */
  path: number[];
};
export type GameInviteEvent = {
  fromPeerId: string;
  fromName: string;
  kind: GameKind;
};
export type GameAcceptedEvent = { fromPeerId: string; kind: GameKind };
export type GameDeclinedEvent = { fromPeerId: string; kind: GameKind };
export type GameMoveEvent   = { fromPeerId: string; kind: GameKind; path: number[] };
export type GameResignedEvent = { fromPeerId: string; kind: GameKind };

export type MeshDebugInfo = {
  mode: string;
  meshState: 'stopped' | 'connecting' | 'connected' | 'error';
  meshIp: string | null;
  meshError: string | null;
  socksPort: number | null;
  tailnetPeers: string[];        // online (reachable) tailnet peers
  libp2pPeers: Array<{ peerId: string; addrs: string[] }>;
  pendingOutRequests: number;
  dialErrors: string[];
};

export type UpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'not-available'; currentVersion: string }
  | { phase: 'available'; version: string }
  | { phase: 'available-external'; version: string }
  | { phase: 'downloading'; percent: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; message: string };

export type AppApi = {
  // app
  getAppVersion(): Promise<string>;

  // auth
  hasIdentity(): Promise<boolean>;
  listProfiles(): Promise<ProfileSummary[]>;
  createIdentity(req: CreateIdentityReq): Promise<{ profileId: string; buddyCode: string }>;
  unlock(req: UnlockReq): Promise<{ ok: true; profileId: string; buddyCode: string }>;
  lock(): Promise<void>;
  factoryReset(): Promise<void>;
  migrateDb(req: { profileId: string; passphrase: string }): Promise<void>;
  getPlatform(): Promise<Platform>;
  getMyId(): Promise<{ peerId: string; buddyCode: string; screenName: string }>;

  // buddies
  listBuddies(): Promise<Buddy[]>;
  addBuddy(req: AddBuddyReq): Promise<Buddy | null>;
  removeBuddy(peerId: string): Promise<void>;
  renameBuddy(peerId: string, alias: string): Promise<void>;
  blockBuddy(peerId: string, blocked: boolean): Promise<void>;
  warnBuddy(peerId: string, delta?: number): Promise<number>;

  // buddy add requests (approve/deny flow)
  sendBuddyRequest(req: BuddyRequestSendReq): Promise<void>;
  listBuddyRequests(): Promise<BuddyRequest[]>;
  approveBuddyRequest(peerId: string): Promise<void>;
  denyBuddyRequest(peerId: string): Promise<void>;
  cancelBuddyRequest(peerId: string): Promise<void>;

  // im
  sendIm(req: SendImReq): Promise<ImMessage>;
  sendTyping(peerId: string, typing: boolean): Promise<void>;
  history(req: HistoryReq): Promise<ImMessage[]>;
  markImRead(peerId: string): Promise<void>;

  // unread
  getUnread(): Promise<UnreadCounts>;
  markRoomRead(roomId: string): Promise<void>;

  // prefs
  getPrefs(): Promise<Prefs>;
  setPrefs(req: SetPrefsReq): Promise<Prefs>;

  // network mode (readable while locked)
  getNetworkConfig(): Promise<NetworkConfig>;
  setNetworkConfig(cfg: NetworkConfig): Promise<NetworkConfig>;

  // presence
  setStatus(req: PresenceSetStatusReq): Promise<SelfPresence>;
  getSelfPresence(): Promise<SelfPresence>;
  getPeerStatus(peerId: string): Promise<BuddyStatusEvent | null>;

  // profile
  getMyProfile(): Promise<Profile>;
  setMyProfile(patch: Partial<Profile>): Promise<Profile>;
  getPeerProfile(peerId: string): Promise<PeerProfile | null>;

  // file transfer
  xferOffer(toPeerId: string): Promise<
    | { id: string; cancelled: true }
    | { id: string; cancelled: false; fileName: string; fileSize: number; peerId: string }
  >;
  xferRespond(id: string, accept: boolean): Promise<{ ok: true }>;

  // voice talk
  talkInvite(peerId: string, kind?: 'voice' | 'video'): Promise<TalkCallState>;
  talkAccept(callId: string): Promise<void>;
  talkReject(callId: string, reason?: string): Promise<void>;
  talkEnd(callId: string): Promise<void>;
  talkSendAudio(callId: string, data: Uint8Array): Promise<void>;
  talkSendVideo(callId: string, data: Uint8Array): Promise<void>;
  talkSetVideo(callId: string, on: boolean): Promise<void>;
  talkGetActive(peerId: string): Promise<TalkCallState | null>;

  // chat rooms
  listRooms(): Promise<Room[]>;
  createRoom(req: RoomCreateReq): Promise<Room>;
  inviteToRoom(req: RoomInviteReq): Promise<Room>;
  leaveRoom(req: RoomLeaveReq): Promise<{ ok: true }>;
  sendRoomMessage(req: RoomSendReq): Promise<RoomMessage>;
  roomHistory(req: RoomHistoryReq): Promise<RoomMessage[]>;
  listRoomChannels(req: RoomChannelsListReq): Promise<RoomChannel[]>;
  createRoomChannel(req: RoomChannelCreateReq): Promise<RoomChannel>;
  deleteRoomChannel(req: RoomChannelDeleteReq): Promise<{ ok: true }>;

  roomVoiceJoin(req: RoomVoiceJoinReq): Promise<{ ok: true }>;
  roomVoiceLeave(req: RoomVoiceLeaveReq): Promise<{ ok: true }>;
  roomVoiceSendAudio(req: RoomVoiceJoinReq, data: Uint8Array): Promise<void>;

  // offline mailbox relay
  mailboxStats(): Promise<MailboxStats>;
  mailboxAddRelay(req: MailboxAddRelayReq): Promise<MailboxStats>;
  mailboxRemoveRelay(req: MailboxRemoveRelayReq): Promise<MailboxStats>;
  mailboxPoll(): Promise<{ relay: string; delivered: number }[]>;

  // Buzz Mesh debug info
  getMeshDebug(): Promise<MeshDebugInfo>;

  // automatic peer discovery (mDNS in p2p mode)
  listDiscovered(): Promise<DiscoveredPeer[]>;

  // events
  onBuddyStatus(cb: (e: BuddyStatusEvent) => void): () => void;
  onImReceived(cb: (e: ImReceivedEvent) => void): () => void;
  onImAck(cb: (e: ImAckEvent) => void): () => void;
  onTyping(cb: (e: { peerId: string; typing: boolean }) => void): () => void;
  onPeerProfile(cb: (e: PeerProfile) => void): () => void;
  onXferOffered(cb: (e: XferOfferEvent) => void): () => void;
  onXferProgress(cb: (e: XferProgressEvent) => void): () => void;
  onXferDone(cb: (e: XferDoneEvent) => void): () => void;
  onRoomMessage(cb: (e: RoomMessageEvent) => void): () => void;
  onRoomInvited(cb: (e: RoomInvitedEvent) => void): () => void;
  onRoomMembers(cb: (e: RoomMembersEvent) => void): () => void;
  onRoomChannel(cb: (e: RoomChannelEvent) => void): () => void;
  onRoomVoicePresence(cb: (e: RoomVoicePresenceEvent) => void): () => void;
  onRoomVoiceAudio(cb: (e: RoomVoiceAudioEvent) => void): () => void;
  onMailboxDelivered(cb: (e: MailboxDeliveredEvent) => void): () => void;
  onDiscovered(cb: (e: DiscoveredEvent) => void): () => void;
  onBuddyRequest(cb: (e: BuddyRequestEvent) => void): () => void;
  onBuddyRequestResolved(cb: (e: BuddyRequestResolvedEvent) => void): () => void;
  onUnread(cb: (e: UnreadCounts) => void): () => void;
  onTalkInvite(cb: (e: TalkInviteEvent) => void): () => void;
  onTalkState(cb: (e: TalkStateEvent) => void): () => void;
  onTalkEnded(cb: (e: TalkEndedEvent) => void): () => void;
  onTalkAudio(cb: (e: TalkAudioEvent) => void): () => void;
  onTalkVideo(cb: (e: TalkVideoEvent) => void): () => void;
  onTalkVideoState(cb: (e: TalkVideoStateEvent) => void): () => void;

  // auto-updates
  updatesCheck(): Promise<UpdateStatus>;
  updatesDownload(): Promise<void>;
  updatesInstall(): Promise<void>;
  updatesOpenReleasePage(): Promise<void>;
  updatesGetStatus(): Promise<UpdateStatus>;
  updatesGetVersion(): Promise<string>;
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void;
  onThemeChanged(cb: (t: Theme) => void): () => void;

  // games
  gameInvite(req: GameInviteReq): Promise<void>;
  gameAccept(toPeerId: string): Promise<void>;
  gameDecline(toPeerId: string): Promise<void>;
  gameMove(req: GameMoveReq): Promise<void>;
  gameResign(toPeerId: string): Promise<void>;
  onGameInvite(cb: (e: GameInviteEvent) => void): () => void;
  onGameAccepted(cb: (e: GameAcceptedEvent) => void): () => void;
  onGameDeclined(cb: (e: GameDeclinedEvent) => void): () => void;
  onGameMove(cb: (e: GameMoveEvent) => void): () => void;
  onGameResigned(cb: (e: GameResignedEvent) => void): () => void;

  // server-mode account management
  /** Probe a Hive server URL and return its name + list of registered users. */
  serverDiscover(serverUrl: string): Promise<ServerDiscoverResult>;
  /** Register a brand-new account on a Hive server and sign in. */
  serverRegister(req: ServerRegisterReq): Promise<{ profileId: string; buddyCode: string }>;
  /** Sign in to an existing account on a Hive server (downloads keystore if needed). */
  serverUnlockAccount(req: ServerUnlockReq): Promise<{ ok: true; profileId: string; buddyCode: string }>;
};

declare global {
  interface Window {
    buzz: AppApi;
  }
}
