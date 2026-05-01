import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from '@shared/ipc.js';
import type { AppApi } from '@shared/types.js';

function on<T>(channel: string, cb: (e: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const api: AppApi = {
  getAppVersion: () => ipcRenderer.invoke(IPC.AppGetVersion),
  hasIdentity: () => ipcRenderer.invoke(IPC.AuthHasIdentity),
  listProfiles: () => ipcRenderer.invoke(IPC.AuthListProfiles),
  createIdentity: (req) => ipcRenderer.invoke(IPC.AuthCreate, req),
  unlock: (req) => ipcRenderer.invoke(IPC.AuthUnlock, req),
  lock: () => ipcRenderer.invoke(IPC.AuthLock),
  factoryReset: () => ipcRenderer.invoke(IPC.AuthFactoryReset),
  migrateDb: (req: { profileId: string; passphrase: string }) =>
    ipcRenderer.invoke(IPC.AuthMigrateDb, req),
  getPlatform: () => ipcRenderer.invoke(IPC.AuthGetPlatform),
  getMyId: () => ipcRenderer.invoke(IPC.AuthGetMyId),

  listBuddies: () => ipcRenderer.invoke(IPC.BuddiesList),
  addBuddy: (req) => ipcRenderer.invoke(IPC.BuddiesAdd, req),
  removeBuddy: (peerId) => ipcRenderer.invoke(IPC.BuddiesRemove, peerId),
  renameBuddy: (peerId, alias) => ipcRenderer.invoke(IPC.BuddiesRename, { peerId, alias }),
  blockBuddy: (peerId, blocked) => ipcRenderer.invoke(IPC.BuddiesBlock, { peerId, blocked }),
  warnBuddy: (peerId, delta = 10) => ipcRenderer.invoke(IPC.BuddiesWarn, { peerId, delta }),

  sendBuddyRequest: (req) => ipcRenderer.invoke(IPC.BuddiesSendRequest, req),
  listBuddyRequests: () => ipcRenderer.invoke(IPC.BuddiesListRequests),
  approveBuddyRequest: (peerId) => ipcRenderer.invoke(IPC.BuddiesApproveRequest, peerId),
  denyBuddyRequest: (peerId) => ipcRenderer.invoke(IPC.BuddiesDenyRequest, peerId),
  cancelBuddyRequest: (peerId) => ipcRenderer.invoke(IPC.BuddiesCancelRequest, peerId),

  sendIm: (req) => ipcRenderer.invoke(IPC.ImSend, req),
  history: (req) => ipcRenderer.invoke(IPC.ImHistory, req),
  markImRead: (peerId) => ipcRenderer.invoke(IPC.ImMarkRead, peerId),

  getUnread: () => ipcRenderer.invoke(IPC.UnreadGet),
  markRoomRead: (roomId) => ipcRenderer.invoke(IPC.RoomsMarkRead, { roomId }),

  getPrefs: () => ipcRenderer.invoke(IPC.PrefsGet),
  setPrefs: (req) => ipcRenderer.invoke(IPC.PrefsSet, req),

  getNetworkConfig: () => ipcRenderer.invoke(IPC.NetworkGet),
  setNetworkConfig: (cfg) => ipcRenderer.invoke(IPC.NetworkSet, cfg),

  setStatus: (req) => ipcRenderer.invoke(IPC.PresenceSetStatus, req),
  getSelfPresence: () => ipcRenderer.invoke(IPC.PresenceGetSelf),
  getPeerStatus: (peerId) => ipcRenderer.invoke(IPC.PresenceGetPeer, peerId),

  getMyProfile: () => ipcRenderer.invoke(IPC.ProfileGetMy),
  setMyProfile: (patch) => ipcRenderer.invoke(IPC.ProfileSetMy, patch),
  getPeerProfile: (peerId) => ipcRenderer.invoke(IPC.ProfileGetPeer, peerId),

  xferOffer: (toPeerId) => ipcRenderer.invoke(IPC.XferOffer, { toPeerId }),
  xferRespond: (id, accept) => ipcRenderer.invoke(IPC.XferRespond, { id, accept }),

  talkInvite: (peerId, kind) => ipcRenderer.invoke(IPC.TalkInvite, { peerId, kind }),
  talkAccept: (callId) => ipcRenderer.invoke(IPC.TalkAccept, { callId }),
  talkReject: (callId, reason) => ipcRenderer.invoke(IPC.TalkReject, { callId, reason }),
  talkEnd: (callId) => ipcRenderer.invoke(IPC.TalkEnd, { callId }),
  talkSendAudio: (callId, data) => ipcRenderer.invoke(IPC.TalkAudio, { callId, data }),
  talkSendVideo: (callId, data) => ipcRenderer.invoke(IPC.TalkVideo, { callId, data }),
  talkSetVideo: (callId, on) => ipcRenderer.invoke(IPC.TalkVideoState, { callId, on }),
  talkGetActive: (peerId) => ipcRenderer.invoke(IPC.TalkGetActive, { peerId }),

  listRooms: () => ipcRenderer.invoke(IPC.RoomsList),
  createRoom: (req) => ipcRenderer.invoke(IPC.RoomsCreate, req),
  inviteToRoom: (req) => ipcRenderer.invoke(IPC.RoomsInvite, req),
  leaveRoom: (req) => ipcRenderer.invoke(IPC.RoomsLeave, req),
  sendRoomMessage: (req) => ipcRenderer.invoke(IPC.RoomsSend, req),
  roomHistory: (req) => ipcRenderer.invoke(IPC.RoomsHistory, req),
  listRoomChannels: (req) => ipcRenderer.invoke(IPC.RoomsListChannels, req),
  createRoomChannel: (req) => ipcRenderer.invoke(IPC.RoomsCreateChannel, req),
  deleteRoomChannel: (req) => ipcRenderer.invoke(IPC.RoomsDeleteChannel, req),
  roomVoiceJoin: (req) => ipcRenderer.invoke(IPC.RoomsVoiceJoin, req),
  roomVoiceLeave: (req) => ipcRenderer.invoke(IPC.RoomsVoiceLeave, req),
  roomVoiceSendAudio: async (req, data) => {
    ipcRenderer.send(IPC.RoomsVoiceSendAudio, req, data);
  },

  mailboxStats: () => ipcRenderer.invoke(IPC.MailboxStats),
  mailboxAddRelay: (req) => ipcRenderer.invoke(IPC.MailboxAddRelay, req),
  mailboxRemoveRelay: (req) => ipcRenderer.invoke(IPC.MailboxRemoveRelay, req),
  mailboxPoll: () => ipcRenderer.invoke(IPC.MailboxPoll),

  listDiscovered: () => ipcRenderer.invoke(IPC.DiscoveryList),

  onBuddyStatus: (cb) => on(IPC.EvtBuddyStatus, cb),
  onImReceived: (cb) => on(IPC.EvtImReceived, cb),
  onImAck: (cb) => on(IPC.EvtImAck, cb),
  onTyping: (cb) => on(IPC.EvtTyping, cb),
  onPeerProfile: (cb) => on(IPC.EvtPeerProfile, cb),
  onXferOffered: (cb) => on(IPC.EvtXferOffered, cb),
  onXferProgress: (cb) => on(IPC.EvtXferProgress, cb),
  onXferDone: (cb) => on(IPC.EvtXferDone, cb),
  onRoomMessage: (cb) => on(IPC.EvtRoomMessage, cb),
  onRoomInvited: (cb) => on(IPC.EvtRoomInvited, cb),
  onRoomMembers: (cb) => on(IPC.EvtRoomMembers, cb),
  onRoomChannel: (cb) => on(IPC.EvtRoomChannel, cb),
  onRoomVoicePresence: (cb) => on(IPC.EvtRoomVoicePresence, cb),
  onRoomVoiceAudio: (cb) => on(IPC.EvtRoomVoiceAudio, cb),
  onMailboxDelivered: (cb) => on(IPC.EvtMailboxDelivered, cb),
  onDiscovered: (cb) => on(IPC.EvtDiscovered, cb),
  onBuddyRequest: (cb) => on(IPC.EvtBuddyRequest, cb),
  onBuddyRequestResolved: (cb) => on(IPC.EvtBuddyRequestResolved, cb),
  onUnread: (cb) => on(IPC.EvtUnread, cb),
  onTalkInvite: (cb) => on(IPC.EvtTalkInvite, cb),
  onTalkState: (cb) => on(IPC.EvtTalkState, cb),
  onTalkEnded: (cb) => on(IPC.EvtTalkEnded, cb),
  onTalkAudio: (cb) => on(IPC.EvtTalkAudio, cb),
  onTalkVideo: (cb) => on(IPC.EvtTalkVideo, cb),
  onTalkVideoState: (cb) => on(IPC.EvtTalkVideoState, cb),

  updatesCheck: () => ipcRenderer.invoke(IPC.UpdatesCheck),
  updatesDownload: () => ipcRenderer.invoke(IPC.UpdatesDownload),
  updatesInstall: () => ipcRenderer.invoke(IPC.UpdatesInstall),
  updatesGetStatus: () => ipcRenderer.invoke(IPC.UpdatesGetStatus),
  updatesGetVersion: () => ipcRenderer.invoke(IPC.UpdatesGetVersion),
  onUpdateStatus: (cb) => on(IPC.EvtUpdateStatus, cb),
  onThemeChanged: (cb) => on('evt:themeChanged', cb),

  // games
  gameInvite: (req) => ipcRenderer.invoke(IPC.GameInvite, req),
  gameAccept: (toPeerId: string) => ipcRenderer.invoke(IPC.GameAccept, toPeerId),
  gameDecline: (toPeerId: string) => ipcRenderer.invoke(IPC.GameDecline, toPeerId),
  gameMove: (req) => ipcRenderer.invoke(IPC.GameMove, req),
  gameResign: (toPeerId: string) => ipcRenderer.invoke(IPC.GameResign, toPeerId),
  onGameInvite: (cb) => on(IPC.EvtGameInvite, cb),
  onGameAccepted: (cb) => on(IPC.EvtGameAccepted, cb),
  onGameDeclined: (cb) => on(IPC.EvtGameDeclined, cb),
  onGameMove: (cb) => on(IPC.EvtGameMove, cb),
  onGameResigned: (cb) => on(IPC.EvtGameResigned, cb),
};

// Window-management helpers that aren't part of the AppApi but are used by
// the buddy list to open IM windows.
const windows = {
  openIm: (peerId: string) => ipcRenderer.invoke('windows:openIm', peerId),
  openVideoCall: (peerId: string) => ipcRenderer.invoke('windows:openVideoCall', peerId),
  openBuddyList: () => ipcRenderer.invoke('windows:openBuddyList'),
  openChat: (roomId: string) => ipcRenderer.invoke('windows:openChat', roomId),
  openGame: (peerId: string, kind: string, initiator?: boolean) => ipcRenderer.invoke('windows:openGame', peerId, kind, initiator),
  openSettings: () => ipcRenderer.invoke('windows:openSettings'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMax: () => ipcRenderer.invoke('window:toggleMax'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximizable: () => ipcRenderer.invoke('window:isMaximizable') as Promise<boolean>,
};

contextBridge.exposeInMainWorld('buzz', api);
contextBridge.exposeInMainWorld('buzzWindows', windows);
