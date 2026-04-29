import type {
  AddBuddyReq,
  Buddy,
  BuddyStatusEvent,
  CreateIdentityReq,
  HistoryReq,
  ImAckEvent,
  ImMessage,
  ImReceivedEvent,
  PeerProfile,
  Prefs,
  PresenceSetStatusReq,
  Profile,
  Room,
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
  XferDoneEvent,
  XferOfferEvent,
  XferProgressEvent,
} from './schemas.js';

export type Platform = 'mac' | 'windows' | 'linux';

export type AppApi = {
  // auth
  hasIdentity(): Promise<boolean>;
  createIdentity(req: CreateIdentityReq): Promise<{ buddyCode: string }>;
  unlock(req: UnlockReq): Promise<{ ok: true; buddyCode: string }>;
  lock(): Promise<void>;
  getPlatform(): Promise<Platform>;
  getMyId(): Promise<{ peerId: string; buddyCode: string; screenName: string }>;

  // buddies
  listBuddies(): Promise<Buddy[]>;
  addBuddy(req: AddBuddyReq): Promise<Buddy>;
  removeBuddy(peerId: string): Promise<void>;
  renameBuddy(peerId: string, alias: string): Promise<void>;
  blockBuddy(peerId: string, blocked: boolean): Promise<void>;
  warnBuddy(peerId: string, delta?: number): Promise<number>;

  // im
  sendIm(req: SendImReq): Promise<ImMessage>;
  history(req: HistoryReq): Promise<ImMessage[]>;

  // prefs
  getPrefs(): Promise<Prefs>;
  setPrefs(req: SetPrefsReq): Promise<Prefs>;

  // network mode (readable while locked)
  getNetworkConfig(): Promise<NetworkConfig>;
  setNetworkConfig(cfg: NetworkConfig): Promise<NetworkConfig>;

  // presence
  setStatus(req: PresenceSetStatusReq): Promise<SelfPresence>;
  getSelfPresence(): Promise<SelfPresence>;

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

  // chat rooms
  listRooms(): Promise<Room[]>;
  createRoom(req: RoomCreateReq): Promise<Room>;
  inviteToRoom(req: RoomInviteReq): Promise<Room>;
  leaveRoom(req: RoomLeaveReq): Promise<{ ok: true }>;
  sendRoomMessage(req: RoomSendReq): Promise<RoomMessage>;
  roomHistory(req: RoomHistoryReq): Promise<RoomMessage[]>;

  // offline mailbox relay
  mailboxStats(): Promise<MailboxStats>;
  mailboxAddRelay(req: MailboxAddRelayReq): Promise<MailboxStats>;
  mailboxRemoveRelay(req: MailboxRemoveRelayReq): Promise<MailboxStats>;
  mailboxPoll(): Promise<{ relay: string; delivered: number }[]>;

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
  onMailboxDelivered(cb: (e: MailboxDeliveredEvent) => void): () => void;
};

declare global {
  interface Window {
    buzz: AppApi;
  }
}
