/**
 * MIT License
 * Copyright (c) 2026 OpenMuse contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * Ported from OpenMuse packages/integrations/src/google.ts (mapMessage /
 * sendEmail + calendar ETag) into Umbra OS backend.
 *
 * Minimal viable port with NO new dependencies (no parse5/zod): manual
 * validation, regex HTML-to-text, strict attachment caps (10 MiB / 20 MiB
 * total), reply-threading checks, and If-Match ETag concurrency for
 * calendar update/delete.
 */

import { randomUUID } from 'node:crypto';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 1024 * 1024;

export class OutcomeUnknownError extends Error {
  readonly code = 'outcome_unknown';
  constructor(message = 'Google may have completed this action. Check Google before trying again.') {
    super(message);
    this.name = 'OutcomeUnknownError';
  }
}

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Google API (${status}): ${detail}`);
    this.name = 'GoogleApiError';
  }
}

export class RecurringEventError extends Error {
  readonly status = 422;
  constructor() {
    super('Recurring events cannot be changed here yet. Open Google Calendar to choose one occurrence or the whole series.');
    this.name = 'RecurringEventError';
  }
}

export interface MailAttachment {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface Mail {
  id: string;
  threadId: string;
  from: string;
  sender: string;
  to: string[];
  subject: string;
  body: string;
  date: string;
  unread: boolean;
  label: string;
  attachments: string[];
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string;
  location: string;
  description: string;
  attendees: string[];
}

export interface EmailDraft {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  threadId?: string;
  replyToMessageId?: string;
}

export interface EventDraft {
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  timeZone?: string;
  location?: string;
  description?: string;
  attendees?: string[];
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

function idPath(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid Google resource ID');
  return encodeURIComponent(id);
}

function calendarPath(calendarId: string): string {
  if (
    !calendarId ||
    calendarId.length > 1024 ||
    Array.from(calendarId).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) ||
    calendarId === '.' ||
    calendarId === '..'
  )
    throw new Error('Invalid Google calendar ID');
  return `${CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events`;
}

function singleLine(value: string, field: string): string {
  if (Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    throw new Error(`Invalid ${field}: header control characters are not allowed`);
  return value;
}

function decodeBase64url(encoded: string, limit = MAX_ATTACHMENT_BYTES): Buffer {
  if (encoded.length > Math.ceil((limit * 4) / 3) + 4)
    throw new Error('Attachment or message body exceeds the size limit');
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(encoded)) throw new Error('Invalid base64url attachment or message body');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length > limit) throw new Error('Attachment or message body is too large');
  if (bytes.toString('base64url') !== encoded.replace(/=+$/, '')) throw new Error('Invalid base64url attachment or message body');
  return bytes;
}

function partHeaders(part?: GmailPart): Map<string, string> {
  return new Map((part?.headers ?? []).map(({ name, value }) => [name.toLowerCase(), value]));
}

function decodeHeader(value: string): string {
  return value
    .replace(/(\?=)[ \t]+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (original, charset: string, encoding: string, text: string) => {
      try {
        const bytes =
          encoding.toLowerCase() === 'b'
            ? Buffer.from(text, 'base64')
            : Buffer.from(
                text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_m: string, code: string) => String.fromCharCode(Number.parseInt(code, 16))),
                'latin1',
              );
        return new TextDecoder(charset).decode(bytes);
      } catch {
        return original;
      }
    });
}

function decodeSnippet(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (original, entity: string) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? original;
    const code = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : original;
  });
}

function addresses(value: string): string[] {
  return value.match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+/g) ?? [];
}

/** Minimal HTML→text (no parse5): strip scripts/styles, break blocks, decode entities. */
function htmlToPlainText(html: string): string {
  return decodeSnippet(
    html
      .replace(/<(script|style|head|template|noscript|iframe|object|svg)[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol|blockquote|section|article|header|footer)>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
      .replace(/[\t \u00a0]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

function mapMessageParts(message: { id: string; threadId: string; snippet?: string; internalDate?: string; labelIds?: string[]; payload?: GmailPart }): Mail {
  const metadata = partHeaders(message.payload);
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: string[] = [];
  const visit = (part: GmailPart, depth: number): void => {
    if (depth > 30) throw new Error('Gmail message MIME nesting exceeds the limit');
    if (part.filename && part.body?.attachmentId) {
      attachments.push(`${message.id}:${part.body.attachmentId}:${encodeURIComponent(part.filename)}`);
    }
    if (!part.filename && (part.mimeType === 'text/plain' || part.mimeType === 'text/html') && part.body?.data) {
      const charset = partHeaders(part).get('content-type')?.match(/charset=["']?([^;"'\s]+)/i)?.[1] ?? 'utf-8';
      const text = new TextDecoder(charset).decode(decodeBase64url(part.body.data, 1024 * 1024));
      if (part.mimeType === 'text/plain') plain.push(text);
      else html.push(htmlToPlainText(text));
    }
    for (const child of part.parts ?? []) visit(child, depth + 1);
  };
  if (message.payload) visit(message.payload, 0);
  const from = decodeHeader(metadata.get('from') ?? '');
  const address = addresses(from)[0] ?? from;
  const sender = from.includes('<') ? from.slice(0, from.indexOf('<')).trim().replace(/^"|"$/g, '') : address;
  const time = message.internalDate ? Number(message.internalDate) : Date.parse(metadata.get('date') ?? '');
  const body = plain.length ? plain.join('\n\n') : html.length ? html.join('\n\n') : decodeSnippet(message.snippet ?? '');
  if (body.length > 1024 * 1024) throw new Error('Gmail message text exceeds the 1 MiB limit');
  const labels = message.labelIds ?? [];
  return {
    id: message.id,
    threadId: message.threadId,
    from: address,
    sender,
    to: addresses(metadata.get('to') ?? ''),
    subject: decodeHeader(metadata.get('subject') ?? '(No subject)'),
    body,
    date: Number.isFinite(time) ? new Date(time).toISOString() : '',
    unread: labels.includes('UNREAD'),
    label: labels.includes('INBOX') ? 'Inbox' : labels.includes('SENT') ? 'Sent' : 'Mail',
    attachments,
  };
}

function mapEvent(value: unknown, calendarId: string, calendarTimeZone = 'UTC'): CalendarEvent {
  const event = value as {
    id: string; etag?: string; recurrence?: string[]; recurringEventId?: string;
    summary?: string; start?: { date?: string; dateTime?: string; timeZone?: string };
    end?: { date?: string; dateTime?: string }; location?: string; description?: string;
    attendees?: { email: string }[];
  };
  if (!event || typeof event.id !== 'string' || !event.id) throw new Error('Invalid Google event');
  if (event.recurrence !== undefined || event.recurringEventId !== undefined) throw new RecurringEventError();
  const allDay = Boolean(event.start?.date);
  const start = allDay ? event.start?.date : event.start?.dateTime;
  const end = allDay ? event.end?.date : event.end?.dateTime;
  if (!start || !end || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) {
    throw new Error('Invalid Google event time range');
  }
  return {
    id: event.id,
    calendarId,
    title: event.summary ?? '(Untitled event)',
    start,
    end,
    allDay,
    timeZone: event.start?.timeZone ?? calendarTimeZone,
    location: event.location ?? '',
    description: event.description ?? '',
    attendees: (event.attendees ?? []).map((a) => a.email),
  };
}

function eventBody(draft: EventDraft, patch = false): Record<string, unknown> {
  return {
    summary: draft.title,
    start: draft.allDay
      ? { date: draft.start, ...(patch ? { dateTime: null } : {}) }
      : { dateTime: draft.start, timeZone: draft.timeZone, ...(patch ? { date: null } : {}) },
    end: draft.allDay
      ? { date: draft.end, ...(patch ? { dateTime: null } : {}) }
      : { dateTime: draft.end, timeZone: draft.timeZone, ...(patch ? { date: null } : {}) },
    location: draft.location,
    description: draft.description,
    attendees: (draft.attendees ?? []).map((email) => ({ email })),
  };
}

function encodedSubject(subject: string): string {
  const chunks: string[] = [];
  let chunk = '';
  for (const char of subject) {
    if (Buffer.byteLength(chunk + char) > 42) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part) => `=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`).join('\r\n ');
}

function wrapBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
}

function validateAttachments(attachments: MailAttachment[]): void {
  if (attachments.length > 10) throw new Error('Attachment count exceeds the limit of 10');
  let total = 0;
  for (const attachment of attachments) {
    singleLine(attachment.name, 'attachment name');
    if (!attachment.name || Buffer.byteLength(attachment.name) > 180) throw new Error('Invalid attachment name length');
    if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(attachment.mimeType)) throw new Error('Invalid attachment MIME type');
    if (attachment.bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('Attachment is too large (10 MiB limit)');
    total += attachment.bytes.length;
  }
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('Total attachment size exceeds the 20 MiB limit');
}

function validateEmailDraft(input: EmailDraft): Required<Pick<EmailDraft, 'to' | 'subject' | 'body'>> & EmailDraft {
  if (!input || !Array.isArray(input.to) || input.to.length === 0) throw new Error('Email requires at least one recipient');
  if (typeof input.subject !== 'string') throw new Error('Email requires a subject');
  if (typeof input.body !== 'string') throw new Error('Email requires a body');
  return { cc: [], bcc: [], ...input };
}

function validateEventDraft(input: EventDraft): EventDraft {
  if (!input || typeof input.title !== 'string' || !input.title) throw new Error('Event requires a title');
  if (!input.start || !input.end || !Number.isFinite(Date.parse(input.start)) || !Number.isFinite(Date.parse(input.end))) {
    throw new Error('Invalid event time range');
  }
  const { calendarId, ...rest } = input;
  return { ...rest, calendarId: calendarId || 'primary' };
}

async function readJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_JSON_BYTES) {
    await response.body?.cancel();
    throw new Error('Google response exceeds the size limit');
  }
  if (!response.body) throw new Error('Google returned an empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new Error('Google response exceeds the size limit');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    reader.releaseLock();
  }
}

export class GoogleClient {
  private readonly fetcher: typeof fetch;
  private readonly getAccessToken: () => Promise<string>;

  constructor(options: { getAccessToken: () => Promise<string>; fetch?: typeof fetch }) {
    this.fetcher = options.fetch ?? fetch;
    this.getAccessToken = options.getAccessToken;
  }

  private eventVersion(event: { etag?: string }, expectedVersion?: string): string {
    if (!event.etag?.trim()) throw new Error('Google event has no ETag; prepare a fresh review');
    const version = singleLine(event.etag, 'event ETag');
    if (expectedVersion !== undefined && version !== expectedVersion) {
      throw new GoogleApiError(409, 'This event changed since review. Prepare a new action.');
    }
    return version;
  }

  private async request(url: string, method = 'GET', body?: unknown, conditionalHeaders: Record<string, string> = {}): Promise<unknown> {
    const write = method !== 'GET';
    const token = await this.getAccessToken();
    if (!token || /[\r\n]/.test(token)) throw new Error('Google access token is missing or invalid; reconnect Google');
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...conditionalHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
        redirect: 'error',
      });
    } catch {
      if (write) throw new OutcomeUnknownError();
      throw new Error('Could not reach Google; check the connection and try again');
    }
    if (write && (response.status >= 500 || response.status === 408)) {
      try {
        await response.body?.cancel();
      } catch {
        throw new OutcomeUnknownError();
      }
      throw new OutcomeUnknownError();
    }
    if (!response.ok) {
      let detail = response.statusText || 'Request failed';
      try {
        const result = (await readJson(response)) as { error?: { message?: string } };
        if (result?.error?.message) detail = String(result.error.message).slice(0, 500);
      } catch {
        // Preserve the definite HTTP rejection even if its body is not JSON.
      }
      throw new GoogleApiError(response.status, detail);
    }
    if (method === 'DELETE' && response.status === 204) return undefined;
    try {
      return await readJson(response);
    } catch {
      if (write) throw new OutcomeUnknownError();
      throw new Error('Google returned an invalid or oversized response');
    }
  }

  async listMail(query = 'in:inbox'): Promise<Mail[]> {
    const params = new URLSearchParams({ maxResults: '30', q: query });
    const list = (await this.request(`${GMAIL}/messages?${params}`)) as { messages?: { id: string }[] };
    const messages = (list.messages ?? []).slice(0, 30);
    return Promise.all(
      messages.map(async ({ id }) => mapMessageParts((await this.request(`${GMAIL}/messages/${idPath(id)}?format=full`)) as Mail & { payload?: GmailPart; snippet?: string; internalDate?: string; labelIds?: string[] })),
    );
  }

  async listEvents(options: { calendarId?: string; timeMin?: string; timeMax?: string } = {}): Promise<CalendarEvent[]> {
    const calendarId = options.calendarId ?? 'primary';
    const path = calendarPath(calendarId);
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const timeMin = options.timeMin ?? midnight.toISOString();
    const timeMax = options.timeMax ?? new Date(Date.parse(timeMin) + 31 * 24 * 60 * 60 * 1000).toISOString();
    const duration = Date.parse(timeMax) - Date.parse(timeMin);
    if (!Number.isFinite(Date.parse(timeMin)) || !Number.isFinite(Date.parse(timeMax))) throw new Error('Invalid calendar range');
    if (duration <= 0 || duration > 366 * 24 * 60 * 60 * 1000) throw new Error('Calendar range must end after it starts and span at most 366 days');
    const params = new URLSearchParams({ maxResults: '100', singleEvents: 'true', orderBy: 'startTime', timeMin, timeMax });
    const result = (await this.request(`${path}?${params}`)) as { items?: unknown[]; timeZone?: string };
    return (result.items ?? []).slice(0, 100).map((item) => mapEvent(item, calendarId, result.timeZone ?? 'UTC'));
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
    const data = (await this.request(`${GMAIL}/messages/${idPath(messageId)}/attachments/${idPath(attachmentId)}`)) as { data: string; size?: number };
    if (data.size !== undefined && data.size > MAX_ATTACHMENT_BYTES) throw new Error('Attachment is too large (10 MiB limit)');
    const bytes = decodeBase64url(data.data);
    if (data.size !== undefined && data.size !== bytes.length) throw new Error('Google attachment size does not match its actual byte length');
    return new Uint8Array(bytes);
  }

  async sendEmail(input: EmailDraft, attachments: MailAttachment[] = []): Promise<{ id: string; threadId?: string }> {
    const draft = validateEmailDraft(input);
    singleLine(draft.subject, 'subject');
    for (const address of [...draft.to, ...(draft.cc ?? []), ...(draft.bcc ?? [])]) singleLine(address, 'recipient');
    validateAttachments(attachments);
    if (draft.threadId && !draft.replyToMessageId) throw new Error('Replies require replyToMessageId to resolve the source message headers');
    let threadId: string | undefined;
    const replyHeaders: string[] = [];
    if (draft.replyToMessageId) {
      const params = new URLSearchParams({ format: 'metadata' });
      for (const name of ['Message-ID', 'References', 'Subject']) params.append('metadataHeaders', name);
      const source = (await this.request(`${GMAIL}/messages/${idPath(draft.replyToMessageId)}?${params}`)) as { threadId: string; payload?: GmailPart };
      if (draft.threadId && source.threadId !== draft.threadId) throw new Error('Reply thread does not match the source message');
      threadId = source.threadId;
      const metadata = partHeaders(source.payload);
      const messageId = singleLine(metadata.get('message-id') ?? '', 'Message-ID');
      if (!/^<[^<>\s]+@[^<>\s]+>$/.test(messageId)) throw new Error('Source message has no valid Message-ID for reply threading');
      const normalizedSubject = (subject: string): string => decodeHeader(subject).replace(/^(?:\s*re:\s*)+/i, '').trim();
      if (normalizedSubject(draft.subject) !== normalizedSubject(metadata.get('subject') ?? '')) {
        throw new Error('Reply subject must match the source message subject');
      }
      const references = singleLine(metadata.get('references') ?? '', 'References').trim();
      if (references && !/^(?:<[^<>\s]+@[^<>\s]+>\s*)+$/.test(references)) throw new Error('Source message has invalid References headers');
      const chain = [...new Set([...(references.match(/<[^<>\s]+>/g) ?? []), messageId])];
      if (chain.join(' ').length > 950) throw new Error('Reply References header exceeds the supported length');
      replyHeaders.push(`In-Reply-To: ${messageId}`, `References: ${chain.join(' ')}`);
    }
    const profile = (await this.request(`${GMAIL}/profile`)) as { emailAddress: string };
    const mimeHeaders = [
      `From: ${singleLine(profile.emailAddress, 'sender')}`,
      `To: ${draft.to.join(',\r\n ')}`,
      ...((draft.cc ?? []).length ? [`Cc: ${(draft.cc ?? []).join(',\r\n ')}`] : []),
      ...((draft.bcc ?? []).length ? [`Bcc: ${(draft.bcc ?? []).join(',\r\n ')}`] : []),
      `Subject: ${encodedSubject(draft.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomUUID()}@openmuse.invalid>`,
      ...replyHeaders,
      'MIME-Version: 1.0',
    ];
    const textPart = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrapBase64(Buffer.from(draft.body.replace(/\r\n|\r|\n/g, '\r\n')))].join('\r\n');
    let mime: string;
    if (!attachments.length) mime = [...mimeHeaders, textPart].join('\r\n');
    else {
      const boundary = `openmuse_${randomUUID()}`;
      const parts = [
        textPart,
        ...attachments.map((attachment) => {
          const name = encodeURIComponent(attachment.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
          return [
            `Content-Type: ${attachment.mimeType}`,
            `Content-Disposition: attachment; filename*=UTF-8''${name}`,
            'Content-Transfer-Encoding: base64',
            '',
            wrapBase64(attachment.bytes),
          ].join('\r\n');
        }),
      ];
      mime = [...mimeHeaders, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts.map((part) => `--${boundary}\r\n${part}`), `--${boundary}--`, ''].join('\r\n');
    }
    const result = (await this.request(`${GMAIL}/messages/send`, 'POST', {
      raw: Buffer.from(mime).toString('base64url'),
      ...(threadId ? { threadId } : {}),
    })) as { id?: string; threadId?: string };
    if (!result || typeof result.id !== 'string' || !result.id) throw new OutcomeUnknownError();
    return { id: result.id, threadId: result.threadId };
  }

  async reviewEvent(calendarId: string, eventId: string): Promise<{ event: CalendarEvent; version: string }> {
    const current = (await this.request(`${calendarPath(calendarId)}/${idPath(eventId)}`)) as { id: string; etag?: string };
    if (current.id !== eventId) throw new Error('Google returned a different event');
    if ((current as { recurrence?: unknown; recurringEventId?: unknown }).recurrence !== undefined || (current as { recurringEventId?: unknown }).recurringEventId !== undefined) {
      throw new RecurringEventError();
    }
    const version = this.eventVersion(current);
    return { event: mapEvent(current, calendarId), version };
  }

  async createEvent(input: EventDraft): Promise<CalendarEvent> {
    const draft = validateEventDraft(input);
    const result = await this.request(`${calendarPath(draft.calendarId)}?sendUpdates=all`, 'POST', eventBody(draft));
    try {
      return mapEvent(result, draft.calendarId, draft.timeZone);
    } catch {
      throw new OutcomeUnknownError();
    }
  }

  async updateEvent(eventId: string, input: EventDraft, expectedVersion?: string): Promise<CalendarEvent> {
    const draft = validateEventDraft(input);
    const current = (await this.request(`${calendarPath(draft.calendarId)}/${idPath(eventId)}`)) as { id: string; etag?: string };
    if (current.id !== eventId) throw new Error('Google returned a different event');
    const result = await this.request(
      `${calendarPath(draft.calendarId)}/${idPath(eventId)}?sendUpdates=all`,
      'PATCH',
      eventBody(draft, true),
      { 'If-Match': this.eventVersion(current, expectedVersion) },
    );
    try {
      return mapEvent(result, draft.calendarId, draft.timeZone);
    } catch {
      throw new OutcomeUnknownError();
    }
  }

  async deleteEvent(calendarId: string, eventId: string, expectedVersion?: string): Promise<void> {
    const current = (await this.request(`${calendarPath(calendarId)}/${idPath(eventId)}`)) as { id: string; etag?: string };
    if (current.id !== eventId) throw new Error('Google returned a different event');
    await this.request(`${calendarPath(calendarId)}/${idPath(eventId)}?sendUpdates=all`, 'DELETE', undefined, {
      'If-Match': this.eventVersion(current, expectedVersion),
    });
  }
}
