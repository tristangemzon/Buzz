// Stable identifiers for IPC channels. Keep in one place.
export const IPC = {
  // app
  AppGetVersion: 'app:getVersion',

  // auth / identity
  AuthHasIdentity: 'auth:hasIdentity',
  AuthListProfiles: 'auth:listProfiles',
  AuthCreate: 'auth:create',
  AuthUnlock: 'auth:unlock',
  AuthLock: 'auth:lock',
  AuthGetPlatform: 'auth:platform',
  AuthGetMyId: 'auth:getMyId',
  AuthFactoryReset: 'auth:factoryReset',
  AuthMigrateDb: 'auth:migrateDb',

  // buddies
  BuddiesList: 'buddies:list',
  BuddiesAdd: 'buddies:add',
  BuddiesRemove: 'buddies:remove',
  BuddiesRename: 'buddies:rename',
  BuddiesBlock: 'buddies:block',
  BuddiesWarn: 'buddies:warn',

  // buddy requests (approve/deny flow)
  BuddiesListRequests: 'buddies:listRequests',
  BuddiesSendRequest: 'buddies:sendRequest',
  BuddiesApproveRequest: 'buddies:approveRequest',
  BuddiesDenyRequest: 'buddies:denyRequest',
  BuddiesCancelRequest: 'buddies:cancelRequest',

  // im
  ImSend: 'im:send',
  ImSendTyping: 'im:sendTyping',
  ImHistory: 'im:history',
  ImMarkRead: 'im:markRead',
  ImEdit: 'im:edit',
  ImDelete: 'im:delete',
  ImReact: 'im:react',
  ImUnreact: 'im:unreact',
  ImSearch: 'im:search',
  ImListReactions: 'im:listReactions',

  // prefs
  PrefsGet: 'prefs:get',
  PrefsSet: 'prefs:set',

  // network mode (readable while locked)
  NetworkGet: 'network:get',
  NetworkSet: 'network:set',

  // presence
  PresenceSetStatus: 'presence:setStatus',
  PresenceGetSelf: 'presence:getSelf',
  PresenceGetPeer: 'presence:getPeer',

  // profile
  ProfileGetMy: 'profile:getMy',
  ProfileSetMy: 'profile:setMy',
  ProfileGetPeer: 'profile:getPeer',

  // file transfer
  XferOffer: 'xfer:offer',
  XferRespond: 'xfer:respond',

  // voice talk
  TalkInvite: 'talk:invite',
  TalkAccept: 'talk:accept',
  TalkReject: 'talk:reject',
  TalkEnd: 'talk:end',
  TalkAudio: 'talk:audio',
  TalkVideo: 'talk:video',
  TalkVideoState: 'talk:videoState',
  TalkGetActive: 'talk:getActive',

  // chat rooms
  RoomsList: 'rooms:list',
  RoomsCreate: 'rooms:create',
  RoomsInvite: 'rooms:invite',
  RoomsLeave: 'rooms:leave',
  RoomsSend: 'rooms:send',
  RoomsHistory: 'rooms:history',
  RoomsListChannels: 'rooms:listChannels',
  RoomsCreateChannel: 'rooms:createChannel',
  RoomsDeleteChannel: 'rooms:deleteChannel',
  RoomsMarkRead: 'rooms:markRead',
  RoomsVoiceJoin: 'rooms:voiceJoin',
  RoomsVoiceLeave: 'rooms:voiceLeave',
  RoomsVoiceSendAudio: 'rooms:voiceSendAudio',
  RoomsReact: 'rooms:react',
  RoomsUnreact: 'rooms:unreact',
  RoomsEditMsg: 'rooms:editMsg',
  RoomsDeleteMsg: 'rooms:deleteMsg',
  // v0.6.0 moderation
  RoomsPin: 'rooms:pin',
  RoomsListPinned: 'rooms:listPinned',
  RoomsKick: 'rooms:kick',
  RoomsSetRole: 'rooms:setRole',
  RoomsSetCategory: 'rooms:setCategory',

  // unread counters
  UnreadGet: 'unread:get',
  // offline mailbox relay
  MailboxStats: 'mailbox:stats',
  MailboxAddRelay: 'mailbox:addRelay',
  MailboxRemoveRelay: 'mailbox:removeRelay',
  MailboxPoll: 'mailbox:poll',

  // automatic peer discovery (mDNS in p2p mode)
  DiscoveryList: 'discovery:list',

  // events (main -> renderer)
  EvtBuddyStatus: 'evt:buddyStatus',
  EvtImReceived: 'evt:imReceived',
  EvtImAck: 'evt:imAck',
  EvtTyping: 'evt:typing',
  EvtReadReceipt: 'evt:readReceipt',
  EvtImEdited: 'evt:imEdited',
  EvtImDeleted: 'evt:imDeleted',
  EvtReaction: 'evt:reaction',
  EvtError: 'evt:error',
  EvtPeerProfile: 'evt:peerProfile',
  EvtXferOffered: 'evt:xferOffered',
  EvtXferProgress: 'evt:xferProgress',
  EvtXferDone: 'evt:xferDone',
  EvtRoomMessage: 'evt:roomMessage',
  EvtRoomInvited: 'evt:roomInvited',
  EvtRoomMembers: 'evt:roomMembers',
  EvtRoomChannel: 'evt:roomChannel',
  EvtRoomVoicePresence: 'evt:roomVoicePresence',
  EvtRoomVoiceAudio: 'evt:roomVoiceAudio',
  // v0.6.0 moderation events
  EvtRoomPin: 'evt:roomPin',
  EvtRoomKick: 'evt:roomKick',
  EvtRoomRole: 'evt:roomRole',
  EvtRoomCategory: 'evt:roomCategory',
  EvtMailboxDelivered: 'evt:mailboxDelivered',
  EvtDiscovered: 'evt:discovered',
  EvtBuddyRequest: 'evt:buddyRequest',
  EvtBuddyRequestResolved: 'evt:buddyRequestResolved',
  EvtUnread: 'evt:unread',
  EvtTalkInvite: 'evt:talkInvite',
  EvtTalkState: 'evt:talkState',
  EvtTalkEnded: 'evt:talkEnded',
  EvtTalkAudio: 'evt:talkAudio',
  EvtTalkVideo: 'evt:talkVideo',
  EvtTalkVideoState: 'evt:talkVideoState',

  // auto-update (electron-updater / GitHub Releases)
  UpdatesCheck: 'updates:check',
  UpdatesDownload: 'updates:download',
  UpdatesInstall: 'updates:install',
  UpdatesGetStatus: 'updates:getStatus',
  UpdatesGetVersion: 'updates:getVersion',
  EvtUpdateStatus: 'evt:updateStatus',

  // Buzz Mesh debug info
  MeshDebugGet: 'mesh:debugGet',

  // peer-to-peer games
  GameInvite: 'game:invite',
  GameAccept: 'game:accept',
  GameDecline: 'game:decline',
  GameMove: 'game:move',
  GameResign: 'game:resign',
  // events (main -> renderer)
  EvtGameInvite: 'evt:gameInvite',
  EvtGameAccepted: 'evt:gameAccepted',
  EvtGameDeclined: 'evt:gameDeclined',
  EvtGameMove: 'evt:gameMove',
  EvtGameResigned: 'evt:gameResigned',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
