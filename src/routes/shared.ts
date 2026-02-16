import type { CallDirection, CallHistoryStatus, CallKind } from '../types';

export type RouteHandler = (req: Request) => Promise<Response>;

export const CALL_HISTORY_LIMIT = 50;
export const DIRECT_MESSAGE_LIMIT = 100;
export const DIRECT_MESSAGE_MAX_LENGTH = 10000;
export const ROOM_MESSAGE_LIMIT = 200;
export const ROOM_MESSAGE_MAX_LENGTH = 2000;
export const MISSING_TABLE_ERROR_CODE = '42P01';
export const MISSING_COLUMN_ERROR_CODE = '42703';
export const USERNAME_MIN_LENGTH = 4;

export const allowedCallDirections = new Set<CallDirection>(['incoming', 'outgoing']);
export const allowedCallStatuses = new Set<CallHistoryStatus>(['completed', 'missed', 'rejected', 'failed']);
export const allowedCallTypes = new Set<CallKind>(['audio', 'video']);

export function parseDate(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function normalizeCallStatus(value?: string | null): CallHistoryStatus {
  if (value === 'completed' || value === 'missed' || value === 'rejected' || value === 'failed') {
    return value;
  }
  return 'failed';
}

export function normalizeCallType(value?: string): CallKind {
  return value === 'video' ? 'video' : 'audio';
}

export const nowIso = () => new Date().toISOString();
