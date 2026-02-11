import type { CreateContactRequest, UpdateContactRequest } from '../types';
import { errorResponse, getBearerToken, jsonResponse } from '../http';
import { supabase, validateToken } from '../supabase';
import { normalizeAvatarUrl } from '../storage';

import type { RouteHandler } from './shared';
import { MISSING_TABLE_ERROR_CODE, nowIso } from './shared';

type ContactRequestRow = {
  id: string;
  requester_id: string;
  target_id: string;
  status: string;
  created_at?: string | null;
  responded_at?: string | null;
};

const CONTACT_REQUEST_STATUS_PENDING = 'pending';
const CONTACT_REQUEST_STATUS_ACCEPTED = 'accepted';
const CONTACT_REQUEST_STATUS_DECLINED = 'declined';
const CONTACT_REQUEST_STATUS_CANCELED = 'canceled';
const CONTACT_REQUEST_ACTIONS = new Set(['accept', 'decline', 'cancel']);

export const contactStorageError = (error: any) => {
  if (error?.code === MISSING_TABLE_ERROR_CODE) {
    return errorResponse('Contacts storage is not configured', 501);
  }
  return errorResponse(error?.message ?? 'Contacts storage error', 500);
};

const contactStatusPriority = (status: string) => {
  if (status === CONTACT_REQUEST_STATUS_ACCEPTED) return 3;
  if (status === CONTACT_REQUEST_STATUS_PENDING) return 2;
  if (status === CONTACT_REQUEST_STATUS_DECLINED) return 1;
  if (status === CONTACT_REQUEST_STATUS_CANCELED) return 1;
  return 0;
};

export const isAcceptedContact = async (userId: string, peerId: string) => {
  const { data, error } = await supabase
    .from('contact_requests')
    .select('id, status, requester_id, target_id, created_at')
    .or(`and(requester_id.eq.${userId},target_id.eq.${peerId}),and(requester_id.eq.${peerId},target_id.eq.${userId})`)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    return { ok: false, error };
  }

  const row = (data || [])[0] as ContactRequestRow | undefined;
  if (!row || row.status !== CONTACT_REQUEST_STATUS_ACCEPTED) {
    return { ok: false };
  }

  return { ok: true };
};

export const contactRoutes: Record<string, RouteHandler> = {
  '/api/contacts': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);
    if (req.method !== 'GET') return errorResponse('Method not allowed', 405);

    const { data: requests, error } = await supabase
      .from('contact_requests')
      .select('id, requester_id, target_id, status, created_at')
      .or(
        `and(requester_id.eq.${userId},status.eq.${CONTACT_REQUEST_STATUS_ACCEPTED}),and(target_id.eq.${userId},status.eq.${CONTACT_REQUEST_STATUS_ACCEPTED})`
      );

    if (error) return contactStorageError(error);

    const contactIds = Array.from(
      new Set(
        (requests || []).map((row: ContactRequestRow) =>
          row.requester_id === userId ? row.target_id : row.requester_id
        )
      )
    );

    if (contactIds.length === 0) return jsonResponse({ contacts: [] });

    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, username, display_name, status, avatar_url, last_seen')
      .in('id', contactIds);

    if (profilesError) return errorResponse(profilesError.message, 500);

    const profilesById = new Map(
      (profiles || []).map((profile) => [
        profile.id,
        {
          ...profile,
          avatar_url: normalizeAvatarUrl(profile.avatar_url),
        },
      ])
    );

    const orderedContacts = contactIds.map((id) => profilesById.get(id)).filter(Boolean);

    return jsonResponse({ contacts: orderedContacts });
  },

  '/api/contacts/search': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);
    if (req.method !== 'GET') return errorResponse('Method not allowed', 405);

    const url = new URL(req.url);
    const query = url.searchParams.get('query')?.trim() ?? '';
    if (!query) return jsonResponse({ users: [] });

    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, status, avatar_url, last_seen')
      .ilike('username', `%${query}%`)
      .limit(20);

    if (error) return errorResponse(error.message, 500);

    const filteredProfiles = (profiles || []).filter((profile) => profile.id !== userId);
    if (filteredProfiles.length === 0) {
      return jsonResponse({ users: [] });
    }

    const peerIds = filteredProfiles.map((profile) => profile.id);
    const relations = new Map<
      string,
      { status: string; requestId?: string | null; direction?: 'incoming' | 'outgoing'; createdAt?: string | null }
    >();

    const { data: outgoing, error: outgoingError } = await supabase
      .from('contact_requests')
      .select('id, requester_id, target_id, status, created_at')
      .eq('requester_id', userId)
      .in('target_id', peerIds);

    if (outgoingError) return contactStorageError(outgoingError);

    const { data: incoming, error: incomingError } = await supabase
      .from('contact_requests')
      .select('id, requester_id, target_id, status, created_at')
      .eq('target_id', userId)
      .in('requester_id', peerIds);

    if (incomingError) return contactStorageError(incomingError);

    const applyRelation = (row: ContactRequestRow, direction: 'incoming' | 'outgoing') => {
      const otherId = direction === 'outgoing' ? row.target_id : row.requester_id;
      const existing = relations.get(otherId);
      const candidatePriority = contactStatusPriority(row.status);
      const existingPriority = existing ? contactStatusPriority(existing.status) : 0;
      if (!existing || candidatePriority > existingPriority) {
        relations.set(otherId, {
          status: row.status,
          requestId: row.id,
          direction,
          createdAt: row.created_at ?? null,
        });
        return;
      }
      if (candidatePriority === existingPriority && row.created_at && existing?.createdAt) {
        if (new Date(row.created_at).getTime() > new Date(existing.createdAt).getTime()) {
          relations.set(otherId, {
            status: row.status,
            requestId: row.id,
            direction,
            createdAt: row.created_at ?? null,
          });
        }
      }
    };

    (outgoing || []).forEach((row: ContactRequestRow) => applyRelation(row, 'outgoing'));
    (incoming || []).forEach((row: ContactRequestRow) => applyRelation(row, 'incoming'));

    const users = filteredProfiles.map((profile) => {
      const relation = relations.get(profile.id);
      let relationStatus: 'contact' | 'incoming' | 'outgoing' | 'none' = 'none';
      if (relation?.status === CONTACT_REQUEST_STATUS_ACCEPTED) {
        relationStatus = 'contact';
      } else if (relation?.status === CONTACT_REQUEST_STATUS_PENDING) {
        relationStatus = relation.direction === 'incoming' ? 'incoming' : 'outgoing';
      }
      return {
        ...profile,
        avatar_url: normalizeAvatarUrl(profile.avatar_url),
        relation: relationStatus,
        request_id: relation?.requestId ?? null,
      };
    });

    return jsonResponse({ users });
  },

  '/api/contacts/requests': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);

    if (req.method === 'GET') {
      const { data: requests, error } = await supabase
        .from('contact_requests')
        .select('id, requester_id, target_id, status, created_at')
        .or(
          `and(requester_id.eq.${userId},status.eq.${CONTACT_REQUEST_STATUS_PENDING}),and(target_id.eq.${userId},status.eq.${CONTACT_REQUEST_STATUS_PENDING})`
        )
        .order('created_at', { ascending: false });

      if (error) return contactStorageError(error);

      const incomingIds = new Set<string>();
      const outgoingIds = new Set<string>();

      (requests || []).forEach((row: ContactRequestRow) => {
        if (row.requester_id === userId) {
          outgoingIds.add(row.target_id);
        } else {
          incomingIds.add(row.requester_id);
        }
      });

      const uniqueIds = Array.from(new Set([...incomingIds, ...outgoingIds]));
      const profilesById = new Map<string, any>();

      if (uniqueIds.length > 0) {
        const { data: profiles, error: profilesError } = await supabase
          .from('profiles')
          .select('id, username, display_name, status, avatar_url, last_seen')
          .in('id', uniqueIds);

        if (profilesError) return errorResponse(profilesError.message, 500);

        (profiles || []).forEach((profile) => {
          profilesById.set(profile.id, {
            ...profile,
            avatar_url: normalizeAvatarUrl(profile.avatar_url),
          });
        });
      }

      const incoming = (requests || [])
        .filter((row: ContactRequestRow) => row.target_id === userId)
        .map((row: ContactRequestRow) => ({
          id: row.id,
          status: row.status,
          created_at: row.created_at ?? null,
          user: profilesById.get(row.requester_id) ?? null,
        }))
        .filter((entry) => entry.user);

      const outgoing = (requests || [])
        .filter((row: ContactRequestRow) => row.requester_id === userId)
        .map((row: ContactRequestRow) => ({
          id: row.id,
          status: row.status,
          created_at: row.created_at ?? null,
          user: profilesById.get(row.target_id) ?? null,
        }))
        .filter((entry) => entry.user);

      return jsonResponse({ incoming, outgoing });
    }

    if (req.method === 'POST') {
      let body: CreateContactRequest;
      try {
        body = (await req.json()) as CreateContactRequest;
      } catch {
        return errorResponse('Invalid request body', 400);
      }

      const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';
      if (!targetId) return errorResponse('targetId is required', 400);
      if (targetId === userId) return errorResponse('Cannot add yourself', 400);

      const { data: existing, error } = await supabase
        .from('contact_requests')
        .select('id, requester_id, target_id, status, created_at')
        .or(`and(requester_id.eq.${userId},target_id.eq.${targetId}),and(requester_id.eq.${targetId},target_id.eq.${userId})`)
        .order('created_at', { ascending: false })
        .limit(1);

      if (error) return contactStorageError(error);

      const existingRow = (existing || [])[0] as ContactRequestRow | undefined;
      if (existingRow) {
        if (existingRow.status === CONTACT_REQUEST_STATUS_ACCEPTED) {
          return errorResponse('Already contacts', 409);
        }
        if (existingRow.status === CONTACT_REQUEST_STATUS_PENDING) {
          if (existingRow.requester_id === userId) {
            return errorResponse('Request already sent', 409);
          }
          return errorResponse('Incoming request already exists', 409);
        }
      }

      const createdAt = nowIso();
      const insertPayload = {
        requester_id: userId,
        target_id: targetId,
        status: CONTACT_REQUEST_STATUS_PENDING,
        created_at: createdAt,
      };

      const { data: request, error: insertError } = await supabase
        .from('contact_requests')
        .insert(insertPayload)
        .select('id, requester_id, target_id, status, created_at')
        .single();

      if (insertError) return contactStorageError(insertError);

      return jsonResponse({ request }, 201);
    }

    if (req.method === 'PATCH') {
      let body: UpdateContactRequest;
      try {
        body = (await req.json()) as UpdateContactRequest;
      } catch {
        return errorResponse('Invalid request body', 400);
      }

      const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
      const action = typeof body.action === 'string' ? body.action.trim() : '';
      if (!requestId) return errorResponse('requestId is required', 400);
      if (!CONTACT_REQUEST_ACTIONS.has(action)) return errorResponse('Invalid action', 400);

      const { data: existing, error } = await supabase
        .from('contact_requests')
        .select('id, requester_id, target_id, status')
        .eq('id', requestId)
        .single();

      if (error) return contactStorageError(error);
      if (!existing) return errorResponse('Request not found', 404);
      if (existing.status !== CONTACT_REQUEST_STATUS_PENDING) {
        return errorResponse('Request already resolved', 409);
      }

      if ((action === 'accept' || action === 'decline') && existing.target_id !== userId) {
        return errorResponse('Forbidden', 403);
      }
      if (action === 'cancel' && existing.requester_id !== userId) {
        return errorResponse('Forbidden', 403);
      }

      const newStatus =
        action === 'accept'
          ? CONTACT_REQUEST_STATUS_ACCEPTED
          : action === 'decline'
            ? CONTACT_REQUEST_STATUS_DECLINED
            : CONTACT_REQUEST_STATUS_CANCELED;

      const { data: updated, error: updateError } = await supabase
        .from('contact_requests')
        .update({ status: newStatus, responded_at: nowIso() })
        .eq('id', requestId)
        .select('id, requester_id, target_id, status, created_at, responded_at')
        .single();

      if (updateError) return contactStorageError(updateError);

      return jsonResponse({ request: updated }, 200);
    }

    return errorResponse('Method not allowed', 405);
  },
};
