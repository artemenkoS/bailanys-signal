export interface WSData {
  userId: string;
  roomId?: string;
  lastPongAt?: number;
}

export interface RegisterRequest {
  email: string;
  password: string;
  username: string;
  displayName?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface CreateDirectMessageRequest {
  peerId: string;
  body: string;
}

export interface CreateContactRequest {
  targetId: string;
}

export interface UpdateContactRequest {
  requestId: string;
  action: "accept" | "decline" | "cancel";
}

export interface UpdateProfileRequest {
  username?: string;
  displayName?: string | null;
}

export interface WebSocketMessage {
  type: string;
  roomId?: string;
  to?: string;
  callType?: string;
  receiverId?: string;
  callId?: string;
  duration?: number;
  create?: boolean;
  name?: string;
  isPrivate?: boolean;
  password?: string;
  [key: string]: any;
}

export type CallDirection = "incoming" | "outgoing";
export type CallHistoryStatus =
  | "completed"
  | "missed"
  | "rejected"
  | "failed";
export type CallKind = "audio" | "video";

export interface CreateCallHistoryRequest {
  peerId?: string;
  roomId?: string;
  direction: CallDirection;
  status: CallHistoryStatus;
  durationSeconds: number;
  callType?: CallKind;
  startedAt?: string;
  endedAt?: string;
}
