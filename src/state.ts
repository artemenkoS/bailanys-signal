import type { ServerWebSocket } from "bun";
import type { CallDirection, CallHistoryStatus, CallKind, WSData } from "./types";

export const users = new Map<string, Set<ServerWebSocket<WSData>>>();
export const rooms = new Map<string, Set<string>>();
export const activeCalls = new Map<string, string>();

export interface InMemoryCallLog {
  id: string;
  peer_id: string;
  direction: CallDirection;
  status: CallHistoryStatus;
  duration_seconds: number;
  call_type: CallKind;
  started_at: string;
  ended_at: string;
}

export const callHistoryByUser = new Map<string, InMemoryCallLog[]>();
