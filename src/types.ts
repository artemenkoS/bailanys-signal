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
  peerId: string;
  direction: CallDirection;
  status: CallHistoryStatus;
  durationSeconds: number;
  callType?: CallKind;
  startedAt?: string;
  endedAt?: string;
}
