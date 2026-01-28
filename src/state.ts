import type { ServerWebSocket } from "bun";
import type { WSData } from "./types";

export const users = new Map<string, Set<ServerWebSocket<WSData>>>();
export const rooms = new Map<string, Set<string>>();
