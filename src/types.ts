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
