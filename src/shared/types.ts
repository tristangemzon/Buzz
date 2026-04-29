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
} from './schemas.js';

export type Platform = 'mac' | 'windows' | 'linux';

export type AppApi = {
  // auth
  hasIdentity(): Promise<boolean>;
  listProfiles(): Promise<ProfileSummary[]>;
  createIdentity(req: CreateIdentityReq): Promise<{ profileId: string; buddyCode: string }>;
  unlock(req: UnlockReq): Promise<{ ok: true; profileId: string; buddyCode: string }>;
  lock(): Promise<void>;
  factoryReset(): Promise<void>;
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
  talkInvite(peerId: string): Promise<TalkCallState>;
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

  // offline mailbox relay
  mailboxStats(): Promise<MailboxStats>;
  mailboxAddRelay(req: MailboxAddRelayReq): Promise<MailboxStats>;
  mailboxRemoveRelay(req: MailboxRemoveRelayReq): Promise<MailboxStats>;
  mailboxPoll(): Promise<{ relay: string; delivered: number }[]>;

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
};

declare global {
  interface Window {
    buzz: AppApi;
  }
}
