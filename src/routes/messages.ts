import type { CreateDirectMessageRequest } from '../types';
import { errorResponse, getBearerToken, jsonResponse } from '../http';
import { supabase, validateToken } from '../supabase';
import { directMessagesByUser } from '../state';
import { sendToUser } from '../ws';
import { decryptChatBody, encryptChatBody } from '../chatCrypto';

import type { RouteHandler } from './shared';
import {
  DIRECT_MESSAGE_LIMIT,
  DIRECT_MESSAGE_MAX_LENGTH,
  MISSING_COLUMN_ERROR_CODE,
  MISSING_TABLE_ERROR_CODE,
  nowIso,
} from './shared';
import { contactStorageError, isAcceptedContact } from './contacts';

type DirectMessage = {
  id: string;
  sender_id: string;
  receiver_id: string;
  body: string;
  created_at: string;
  edited_at?: string | null;
  deleted_at?: string | null;
};

const storeDirectMessageFallback = (message: DirectMessage) => {
  const targets = [message.sender_id, message.receiver_id];
  for (const userId of targets) {
    const existing = directMessagesByUser.get(userId) || [];
    const index = existing.findIndex((item) => item.id === message.id);
    if (index >= 0) {
      existing[index] = message;
    } else {
      existing.push(message);
    }
    if (existing.length > DIRECT_MESSAGE_LIMIT) {
      existing.splice(0, existing.length - DIRECT_MESSAGE_LIMIT);
    }
    directMessagesByUser.set(userId, existing);
  }
};

const getDirectMessagesFallback = (userId: string, peerId: string): DirectMessage[] => {
  const existing = directMessagesByUser.get(userId) || [];
  return existing
    .filter(
      (message) =>
        (message.sender_id === userId && message.receiver_id === peerId) ||
        (message.sender_id === peerId && message.receiver_id === userId)
    )
    .slice(-DIRECT_MESSAGE_LIMIT);
};

const findDirectMessageFallback = (messageId: string): DirectMessage | null => {
  for (const [, messages] of directMessagesByUser) {
    const found = messages.find((message) => message.id === messageId);
    if (found) return found;
  }
  return null;
};

export const messageRoutes: Record<string, RouteHandler> = {
  '/api/messages': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);

    const url = new URL(req.url);
    if (req.method === 'GET') {
      const peerId = url.searchParams.get('peerId')?.trim() ?? '';
      if (!peerId) return errorResponse('peerId is required', 400);
      if (peerId === userId) return errorResponse('Invalid peerId', 400);

      const contactCheck = await isAcceptedContact(userId, peerId);
      if (!contactCheck.ok) {
        if (contactCheck.error) return contactStorageError(contactCheck.error);
        return errorResponse('Contacts only', 403);
      }

      let messages: DirectMessage[] | null = null;
      let error: any = null;

      ({ data: messages, error } = await supabase
        .from('direct_messages')
        .select('id, sender_id, receiver_id, body, created_at, edited_at, deleted_at')
        .or(`and(sender_id.eq.${userId},receiver_id.eq.${peerId}),and(sender_id.eq.${peerId},receiver_id.eq.${userId})`)
        .order('created_at', { ascending: false })
        .limit(DIRECT_MESSAGE_LIMIT));

      if (error?.code === MISSING_COLUMN_ERROR_CODE) {
        ({ data: messages, error } = await supabase
          .from('direct_messages')
          .select('id, sender_id, receiver_id, body, created_at')
          .or(
            `and(sender_id.eq.${userId},receiver_id.eq.${peerId}),and(sender_id.eq.${peerId},receiver_id.eq.${userId})`
          )
          .order('created_at', { ascending: false })
          .limit(DIRECT_MESSAGE_LIMIT));
      }

      if (error) {
        if (error.code === MISSING_TABLE_ERROR_CODE || error.code === MISSING_COLUMN_ERROR_CODE) {
          const fallbackMessages = getDirectMessagesFallback(userId, peerId);
          try {
            const decryptedFallback = fallbackMessages.map((message) => ({
              ...message,
              body: decryptChatBody(message.body),
              edited_at: message.edited_at ?? null,
              deleted_at: message.deleted_at ?? null,
            }));
            return jsonResponse({ messages: decryptedFallback });
          } catch (decryptError: any) {
            return errorResponse(decryptError?.message ?? 'Failed to decrypt messages', 500);
          }
        }
        return errorResponse(error.message, 500);
      }

      try {
        const normalized = (messages || [])
          .slice()
          .reverse()
          .map((message) => ({
            ...message,
            body: decryptChatBody(message.body),
            edited_at: message.edited_at ?? null,
            deleted_at: message.deleted_at ?? null,
          }));
        return jsonResponse({ messages: normalized });
      } catch (decryptError: any) {
        return errorResponse(decryptError?.message ?? 'Failed to decrypt messages', 500);
      }
    }

    if (req.method === 'POST') {
      let body: CreateDirectMessageRequest;
      try {
        body = (await req.json()) as CreateDirectMessageRequest;
      } catch {
        return errorResponse('Invalid request body', 400);
      }

      try {
        const peerId = typeof body.peerId === 'string' ? body.peerId.trim() : '';
        const messageBody = typeof body.body === 'string' ? body.body.trim() : '';

        if (!peerId) return errorResponse('peerId is required', 400);
        if (peerId === userId) return errorResponse('Invalid peerId', 400);
        if (!messageBody) return errorResponse('Message body is required', 400);
        if (messageBody.length > DIRECT_MESSAGE_MAX_LENGTH) {
          return errorResponse('Message is too long', 400);
        }

        const contactCheck = await isAcceptedContact(userId, peerId);
        if (!contactCheck.ok) {
          if (contactCheck.error) return contactStorageError(contactCheck.error);
          return errorResponse('Contacts only', 403);
        }

        const createdAt = nowIso();
        const encryptedBody = encryptChatBody(messageBody);
        const fallbackMessage: DirectMessage = {
          id: crypto.randomUUID(),
          sender_id: userId,
          receiver_id: peerId,
          body: encryptedBody,
          created_at: createdAt,
          edited_at: null,
          deleted_at: null,
        };

        const insertPayload = {
          sender_id: userId,
          receiver_id: peerId,
          body: encryptedBody,
          created_at: createdAt,
        };

        let data: any = null;
        let error: any = null;
        ({ data, error } = await supabase
          .from('direct_messages')
          .insert(insertPayload)
          .select('id, sender_id, receiver_id, body, created_at, edited_at, deleted_at')
          .single());

        if (error?.code === MISSING_COLUMN_ERROR_CODE) {
          ({ data, error } = await supabase
            .from('direct_messages')
            .insert(insertPayload)
            .select('id, sender_id, receiver_id, body, created_at')
            .single());
        }

        let storedMessage = fallbackMessage;
        if (error) {
          if (error.code === MISSING_TABLE_ERROR_CODE || error.code === MISSING_COLUMN_ERROR_CODE) {
            storeDirectMessageFallback(fallbackMessage);
          } else {
            return errorResponse(error.message, 500);
          }
        } else if (data) {
          storedMessage = data as DirectMessage;
          storeDirectMessageFallback(storedMessage);
        }

        const responseMessage = {
          ...storedMessage,
          body: messageBody,
        };
        sendToUser(peerId, { type: 'chat-message', message: responseMessage });
        sendToUser(userId, { type: 'chat-message', message: responseMessage });
        return jsonResponse({ message: responseMessage }, 201);
      } catch (err: any) {
        return errorResponse(err?.message ?? 'Internal error', 500);
      }
    }

    if (req.method === 'PATCH') {
      let body: { id?: string; body?: string };
      try {
        body = (await req.json()) as { id?: string; body?: string };
      } catch {
        return errorResponse('Invalid request body', 400);
      }

      try {
        const messageId = typeof body.id === 'string' ? body.id.trim() : '';
        const messageBody = typeof body.body === 'string' ? body.body.trim() : '';
        if (!messageId) return errorResponse('id is required', 400);
        if (!messageBody) return errorResponse('Message body is required', 400);
        if (messageBody.length > DIRECT_MESSAGE_MAX_LENGTH) {
          return errorResponse('Message is too long', 400);
        }

        const updatedAt = nowIso();
        const encryptedBody = encryptChatBody(messageBody);
        const updatePayload = {
          body: encryptedBody,
          edited_at: updatedAt,
          deleted_at: null,
        };

        let data: any = null;
        let error: any = null;
        ({ data, error } = await supabase
          .from('direct_messages')
          .update(updatePayload)
          .eq('id', messageId)
          .eq('sender_id', userId)
          .select('id, sender_id, receiver_id, body, created_at, edited_at, deleted_at')
          .single());

        if (error?.code === MISSING_COLUMN_ERROR_CODE) {
          ({ data, error } = await supabase
            .from('direct_messages')
            .update({ body: encryptedBody })
            .eq('id', messageId)
            .eq('sender_id', userId)
            .select('id, sender_id, receiver_id, body, created_at')
            .single());
        }

        if (error) {
          if (error.code === MISSING_TABLE_ERROR_CODE) {
            const existing = findDirectMessageFallback(messageId);
            if (!existing || existing.sender_id !== userId) {
              return errorResponse('Message not found', 404);
            }
            const updatedMessage: DirectMessage = {
              ...existing,
              body: encryptedBody,
              edited_at: updatedAt,
              deleted_at: null,
            };
            storeDirectMessageFallback(updatedMessage);
            const responseMessage = {
              ...updatedMessage,
              body: messageBody,
            };
            sendToUser(existing.receiver_id, { type: 'chat-message', message: responseMessage });
            sendToUser(userId, { type: 'chat-message', message: responseMessage });
            return jsonResponse({ message: responseMessage }, 200);
          }
          return errorResponse(error.message, 500);
        }

        if (!data) return errorResponse('Message not found', 404);
        const storedMessage = data as DirectMessage;
        const responseMessage = {
          ...storedMessage,
          body: messageBody,
        };
        storeDirectMessageFallback(storedMessage);
        sendToUser(storedMessage.receiver_id, { type: 'chat-message', message: responseMessage });
        sendToUser(userId, { type: 'chat-message', message: responseMessage });
        return jsonResponse({ message: responseMessage }, 200);
      } catch (err: any) {
        return errorResponse(err?.message ?? 'Internal error', 500);
      }
    }

    if (req.method === 'DELETE') {
      const messageId = url.searchParams.get('id')?.trim() ?? '';
      if (!messageId) return errorResponse('id is required', 400);
      try {
        const deletedAt = nowIso();
        const encryptedBody = encryptChatBody('');
        const updatePayload = {
          body: encryptedBody,
          deleted_at: deletedAt,
          edited_at: null,
        };

        let data: any = null;
        let error: any = null;
        ({ data, error } = await supabase
          .from('direct_messages')
          .update(updatePayload)
          .eq('id', messageId)
          .eq('sender_id', userId)
          .select('id, sender_id, receiver_id, body, created_at, edited_at, deleted_at')
          .single());

        if (error?.code === MISSING_COLUMN_ERROR_CODE) {
          ({ data, error } = await supabase
            .from('direct_messages')
            .update({ body: encryptedBody })
            .eq('id', messageId)
            .eq('sender_id', userId)
            .select('id, sender_id, receiver_id, body, created_at')
            .single());
        }

        if (error) {
          if (error.code === MISSING_TABLE_ERROR_CODE) {
            const existing = findDirectMessageFallback(messageId);
            if (!existing || existing.sender_id !== userId) {
              return errorResponse('Message not found', 404);
            }
            const deletedMessage: DirectMessage = {
              ...existing,
              body: encryptedBody,
              deleted_at: deletedAt,
              edited_at: null,
            };
            storeDirectMessageFallback(deletedMessage);
            const responseMessage = {
              ...deletedMessage,
              body: '',
            };
            sendToUser(existing.receiver_id, { type: 'chat-message', message: responseMessage });
            sendToUser(userId, { type: 'chat-message', message: responseMessage });
            return jsonResponse({ message: responseMessage }, 200);
          }
          return errorResponse(error.message, 500);
        }

        if (!data) return errorResponse('Message not found', 404);
        const storedMessage = data as DirectMessage;
        const responseMessage = {
          ...storedMessage,
          body: '',
        };
        storeDirectMessageFallback(storedMessage);
        sendToUser(storedMessage.receiver_id, { type: 'chat-message', message: responseMessage });
        sendToUser(userId, { type: 'chat-message', message: responseMessage });
        return jsonResponse({ message: responseMessage }, 200);
      } catch (err: any) {
        return errorResponse(err?.message ?? 'Internal error', 500);
      }
    }

    return errorResponse('Method not allowed', 405);
  },
};
