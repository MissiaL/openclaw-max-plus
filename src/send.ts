/**
 * Outbound message sending for MAX.
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';

import { resolveMaxAccount } from './accounts.js';
import {
  MaxApi,
  type MaxAttachment,
  type MaxInlineKeyboardAttachment,
  type MaxInlineKeyboardButton,
  type MaxNewMessageBody,
  type MaxSendResult,
  type MaxStickerAttachment,
} from './api.js';
import { getMaxRuntime } from './runtime.js';

export type MaxSendButtonType =
  | 'callback'
  | 'link'
  | 'request_contact'
  | 'request_geo_location'
  | 'open_app'
  | 'message'
  | 'clipboard';

export type MaxSendButton = {
  text: string;
  /** Explicit button type. Inferred when omitted: url → link, else callback. */
  type?: MaxSendButtonType;
  payload?: string;
  callback_data?: string;
  url?: string;
  /** callback button colour */
  intent?: 'default' | 'positive' | 'negative';
  /** request_geo_location: skip the confirmation prompt */
  quick?: boolean;
  /** open_app: mini-app URL */
  webApp?: string;
  /** open_app: contact id passed to the mini-app */
  contactId?: number;
};

export interface MaxSendOptions {
  token?: string;
  baseUrl?: string;
  accountId?: string;
  cfg?: OpenClawConfig;
  replyToMessageId?: string;
  forwardMessageId?: string;
  format?: 'markdown' | 'html';
  disableLinkPreview?: boolean;
  notify?: boolean;
  buttons?: MaxSendButton[][];
}

/**
 * Resolve the API options (token + base URL) from options or config.
 * baseUrl resolution: explicit opt → per-account `apiBaseUrl` config. When
 * neither is set, MaxApi falls back to the MAX_API_BASE_URL env / default.
 */
function resolveApiOptions(opts: MaxSendOptions): { token: string; baseUrl?: string } {
  if (opts.token) return { token: opts.token, baseUrl: opts.baseUrl };
  if (opts.cfg) {
    const account = resolveMaxAccount({ cfg: opts.cfg, accountId: opts.accountId });
    if (account.token) {
      return { token: account.token, baseUrl: opts.baseUrl ?? account.config.apiBaseUrl };
    }
  }
  throw new Error('MAX bot token not available');
}

/** MAX caps a single message body at 4000 characters. */
export const MAX_TEXT_LEN = 4000;

/**
 * Split a media caption that exceeds MAX's 4000-char body limit. The first chunk
 * rides with the media message; the remainder becomes follow-up text messages
 * (chunked via the injected markdown chunker) so neither the media nor the text
 * is dropped to a 400 Bad Request.
 */
export function splitMediaCaption(
  caption: string,
  chunk: (text: string, limit: number) => string[],
): { mediaCaption: string; followups: string[] } {
  if (caption.length <= MAX_TEXT_LEN) return { mediaCaption: caption, followups: [] };
  const parts = chunk(caption, MAX_TEXT_LEN).filter((p) => p.length > 0);
  const [first, ...rest] = parts;
  return { mediaCaption: first ?? '', followups: rest };
}

type MaxUploadType = 'image' | 'video' | 'audio' | 'file';

/** Sniff leading magic bytes → MAX upload type + canonical MIME. An optional
 *  MIME hint (e.g. from a data: URI) is used only as a fallback. Returns
 *  undefined when the bytes are not recognizable media. */
function sniffMedia(
  buf: Buffer,
  mimeHint?: string,
): { type: MaxUploadType; mime: string } | undefined {
  const hex = buf.subarray(0, 4).toString('hex');
  const a4 = buf.subarray(0, 4).toString('latin1');
  const a8_12 = buf.subarray(8, 12).toString('latin1');
  if (hex.startsWith('89504e47')) return { type: 'image', mime: 'image/png' };
  if (hex.startsWith('ffd8ff')) return { type: 'image', mime: 'image/jpeg' };
  if (a4 === 'GIF8') return { type: 'image', mime: 'image/gif' };
  if (a4 === 'RIFF' && a8_12 === 'WEBP') return { type: 'image', mime: 'image/webp' };
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return { type: 'video', mime: 'video/mp4' };
  if (a4 === 'OggS') return { type: 'audio', mime: 'audio/ogg' };
  if (hex.startsWith('494433') || hex.startsWith('fffb') || hex.startsWith('fff3'))
    return { type: 'audio', mime: 'audio/mpeg' };
  if (a4 === 'RIFF' && a8_12 === 'WAVE') return { type: 'audio', mime: 'audio/wav' };
  if (a4 === '%PDF') return { type: 'file', mime: 'application/pdf' };
  // Unknown magic — trust an explicit MIME hint if it names a media class.
  if (mimeHint) {
    if (mimeHint.startsWith('image/')) return { type: 'image', mime: mimeHint };
    if (mimeHint.startsWith('video/')) return { type: 'video', mime: mimeHint };
    if (mimeHint.startsWith('audio/')) return { type: 'audio', mime: mimeHint };
  }
  return undefined;
}

/**
 * Detect media handed in as inline content — a base64 `data:` URI or raw base64
 * (e.g. a generated image the host inlines instead of writing to disk) — and
 * decode it to a buffer. Returns undefined for normal file paths / URLs so the
 * caller treats them as before. Raw base64 is accepted only when it decodes to
 * recognizable media magic bytes, so a (long) file path is never mistaken for
 * content and read with the whole string as a filename (ENAMETOOLONG).
 */
export function resolveInlineMedia(
  src: string,
): { buffer: Buffer; type: MaxUploadType; mime?: string } | undefined {
  if (/^https?:\/\//i.test(src)) return undefined;

  const dataUri = /^data:([\w/+.-]*?)(;base64)?,([\s\S]*)$/i.exec(src);
  if (dataUri) {
    if (!dataUri[2]) return undefined; // only base64-encoded data: URIs
    const mimeHint = dataUri[1] || undefined;
    try {
      const buffer = Buffer.from(dataUri[3], 'base64');
      if (buffer.length === 0) return undefined;
      const sniff = sniffMedia(buffer, mimeHint);
      return {
        buffer,
        type: sniff?.type ?? 'file',
        mime: sniff?.mime ?? mimeHint,
      };
    } catch {
      return undefined;
    }
  }

  // Raw base64 (no data: prefix): accept only when the WHOLE string is base64
  // (file paths have '.', '-' etc.) AND it decodes to recognized media magic
  // bytes — so a path is never mistaken for content (which fs.read would reject
  // with ENAMETOOLONG/ENOENT).
  if (src.length >= 16 && /^[A-Za-z0-9+/=\s]+$/.test(src)) {
    try {
      const buffer = Buffer.from(src.replace(/\s/g, ''), 'base64');
      if (buffer.length < 8) return undefined;
      const sniff = sniffMedia(buffer);
      if (!sniff) return undefined; // unrecognized → treat the original as a path
      return { buffer, type: sniff.type, mime: sniff.mime };
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function normalizeTargetId(to: string): number {
  const normalized = to.startsWith('max:') ? to.slice(4) : to;
  const chatId = Number(normalized);
  if (Number.isNaN(chatId)) {
    throw new Error(`Invalid MAX target: ${to}`);
  }
  return chatId;
}

export function readMaxChannelButtons(channelData: unknown): MaxSendButton[][] | undefined {
  if (!channelData || typeof channelData !== 'object' || Array.isArray(channelData))
    return undefined;
  const maxData = (channelData as Record<string, unknown>).max;
  if (!maxData || typeof maxData !== 'object' || Array.isArray(maxData)) return undefined;
  const rawButtons = (maxData as Record<string, unknown>).buttons;
  if (!Array.isArray(rawButtons)) return undefined;

  const rows = rawButtons
    .map((row) => {
      const items = Array.isArray(row) ? row : [row];
      return items
        .filter(
          (button): button is Record<string, unknown> =>
            Boolean(button) && typeof button === 'object' && !Array.isArray(button),
        )
        .map((button): MaxSendButton => {
          const rawType = button.type != null ? String(button.type) : undefined;
          const knownTypes: MaxSendButtonType[] = [
            'callback',
            'link',
            'request_contact',
            'request_geo_location',
            'open_app',
            'message',
            'clipboard',
          ];
          const intentRaw = button.intent != null ? String(button.intent) : undefined;
          const contactIdRaw = button.contactId ?? button.contact_id;
          return {
            text: String(button.text ?? button.label ?? ''),
            type: knownTypes.includes(rawType as MaxSendButtonType)
              ? (rawType as MaxSendButtonType)
              : undefined,
            payload: button.payload != null ? String(button.payload) : undefined,
            callback_data: button.callback_data != null ? String(button.callback_data) : undefined,
            url: button.url != null ? String(button.url) : undefined,
            intent:
              intentRaw === 'positive' || intentRaw === 'negative' || intentRaw === 'default'
                ? intentRaw
                : undefined,
            quick: typeof button.quick === 'boolean' ? button.quick : undefined,
            webApp:
              button.webApp != null
                ? String(button.webApp)
                : button.web_app != null
                  ? String(button.web_app)
                  : undefined,
            contactId: contactIdRaw != null ? Number(contactIdRaw) : undefined,
          };
        })
        .filter((button) => button.text.trim().length > 0);
    })
    .filter((row) => row.length > 0);

  return rows.length > 0 ? rows : undefined;
}

/**
 * Send a text message to a MAX chat or user.
 */
/** Map a high-level MaxSendButton to the MAX inline-keyboard wire shape. */
function mapMaxButton(btn: MaxSendButton): MaxInlineKeyboardButton {
  const type: MaxSendButtonType = btn.type ?? (btn.url ? 'link' : 'callback');
  switch (type) {
    case 'link':
      return { type: 'link', text: btn.text, url: btn.url ?? '' };
    case 'request_contact':
      return { type: 'request_contact', text: btn.text };
    case 'request_geo_location':
      return {
        type: 'request_geo_location',
        text: btn.text,
        ...(btn.quick != null ? { quick: btn.quick } : {}),
      };
    case 'open_app':
      return {
        type: 'open_app',
        text: btn.text,
        ...(btn.webApp ? { web_app: btn.webApp } : {}),
        ...(btn.payload ? { payload: btn.payload } : {}),
        ...(btn.contactId != null ? { contact_id: btn.contactId } : {}),
      };
    case 'message':
      return { type: 'message', text: btn.text };
    case 'clipboard':
      return {
        type: 'clipboard',
        text: btn.text,
        payload: btn.payload ?? btn.callback_data ?? btn.text,
      };
    case 'callback':
    default:
      return {
        type: 'callback',
        text: btn.text,
        payload: btn.payload ?? btn.callback_data ?? btn.text,
        ...(btn.intent ? { intent: btn.intent } : {}),
      };
  }
}

function buildInlineKeyboard(buttons: MaxSendButton[][]): MaxInlineKeyboardAttachment {
  return {
    type: 'inline_keyboard',
    payload: { buttons: buttons.map((row) => row.map(mapMaxButton)) },
  };
}

function buildMaxTextBody(text: string, opts: MaxSendOptions = {}): MaxNewMessageBody {
  const body: MaxNewMessageBody = {
    text: text || undefined,
    format: opts.format ?? undefined,
    notify: opts.notify,
  };

  // Link context: forward takes precedence over reply (MAX allows only one link).
  if (opts.forwardMessageId) {
    body.link = { type: 'forward', mid: opts.forwardMessageId };
  } else if (opts.replyToMessageId) {
    body.link = { type: 'reply', mid: opts.replyToMessageId };
  }

  // Inline keyboard from buttons
  if (opts.buttons?.length) {
    body.attachments = [buildInlineKeyboard(opts.buttons)];
  }

  return body;
}

export async function sendMaxMessage(
  to: string,
  text: string,
  opts: MaxSendOptions = {},
): Promise<{ messageId: string; raw: MaxSendResult }> {
  const api = new MaxApi(resolveApiOptions(opts));

  const chatId = normalizeTargetId(to);

  // Build message body
  const body = buildMaxTextBody(text, opts);

  // Determine params
  const params: { chat_id?: number; user_id?: number; disable_link_preview?: boolean } = {};

  // Could be either chat_id or user_id. For DMs, prefer chat_id if negative or large.
  // MAX uses positive IDs for both users and chats.
  // Convention: if we have a chat_id from an inbound message, use chat_id.
  params.chat_id = chatId;

  if (opts.disableLinkPreview) {
    params.disable_link_preview = true;
  }

  const result = await api.sendMessage(body, params);

  return {
    messageId: result.message?.body?.mid ?? '',
    raw: result,
  };
}

/**
 * Answer a MAX callback. Unlike /messages, /answers is scoped by callback_id
 * and works even when the callback update does not expose a sendable chat_id.
 */
export async function answerMaxCallback(
  callbackId: string,
  text: string,
  opts: MaxSendOptions & { notification?: string } = {},
): Promise<void> {
  const api = new MaxApi(resolveApiOptions(opts));
  // Both fields are optional on /answers: `message` replaces the original
  // message, `notification` shows a one-shot toast. Omit an empty message so a
  // toast-only ack does not also blank out the message.
  const message = text ? buildMaxTextBody(text, opts) : undefined;
  await api.answerCallback(callbackId, { message, notification: opts.notification });
}

/**
 * Resolve the bot's own membership/rights in a chat. Returns isMember=false when
 * the bot is not a member (the API rejects, typically 404). Use as a preflight
 * before privileged actions (pin, member management).
 */
export async function getMaxMembership(
  to: string,
  opts: MaxSendOptions = {},
): Promise<{ isMember: boolean; isAdmin: boolean; permissions: string[] }> {
  const api = new MaxApi(resolveApiOptions(opts));
  try {
    const m = await api.getMyMembership(normalizeTargetId(to));
    return {
      isMember: true,
      isAdmin: Boolean(m.is_admin || m.is_owner),
      permissions: m.permissions ?? [],
    };
  } catch {
    return { isMember: false, isAdmin: false, permissions: [] };
  }
}

/**
 * Pin a message in a MAX chat. Requires the bot to be an admin; group/channel only.
 */
export async function pinMaxMessage(
  to: string,
  messageId: string,
  opts: MaxSendOptions & { notify?: boolean } = {},
): Promise<void> {
  const api = new MaxApi(resolveApiOptions(opts));
  await api.pinMessage(normalizeTargetId(to), messageId, { notify: opts.notify });
}

/**
 * Unpin the currently pinned message in a MAX chat. Admin-only; group/channel only.
 */
export async function unpinMaxMessage(to: string, opts: MaxSendOptions = {}): Promise<void> {
  const api = new MaxApi(resolveApiOptions(opts));
  await api.unpinMessage(normalizeTargetId(to));
}

/**
 * Edit an existing MAX message.
 */
export async function editMaxMessage(
  messageId: string,
  text: string,
  opts: MaxSendOptions = {},
): Promise<void> {
  const api = new MaxApi(resolveApiOptions(opts));

  await api.editMessage(messageId, {
    text,
    format: opts.format ?? undefined,
  });
}

/**
 * Delete a MAX message.
 */
export async function deleteMaxMessage(
  messageId: string,
  opts: MaxSendOptions = {},
): Promise<void> {
  const api = new MaxApi(resolveApiOptions(opts));

  await api.deleteMessage(messageId);
}

/**
 * Send a media message to MAX (with upload).
 * @param to Chat ID or user ID
 * @param caption Text caption
 * @param mediaPath Local file path or URL
 * @param opts Send options
 */
export async function sendMaxMediaMessage(
  to: string,
  caption: string,
  mediaPath: string,
  opts: MaxSendOptions = {},
): Promise<{ messageId: string; raw: MaxSendResult }> {
  const api = new MaxApi(resolveApiOptions(opts));

  // uploadMedia reads string sources from disk, so a remote http(s) URL must be
  // downloaded to a temp file first (channel.ts passes through remote mediaUrls).
  let uploadSource: string | Buffer = mediaPath;
  let mediaType: 'image' | 'video' | 'audio' | 'file' = 'file';
  let inlineMime: string | undefined;
  let tmpToCleanup: string | undefined;

  const inline = resolveInlineMedia(mediaPath);
  if (inline) {
    // The host/agent may hand us inline base64 (e.g. a generated image) instead
    // of a file path — upload the decoded buffer directly rather than fs.read a
    // huge base64 string as a filename (ENAMETOOLONG).
    uploadSource = inline.buffer;
    mediaType = inline.type;
    inlineMime = inline.mime;
  } else {
    let nameForType = mediaPath;
    if (/^https?:\/\//i.test(mediaPath)) {
      const maxBytes = ((opts as { mediaMaxMb?: number }).mediaMaxMb ?? 20) * 1024 * 1024;
      const loaded = await getMaxRuntime().channel.media.readRemoteMediaBuffer({
        url: mediaPath,
        maxBytes,
      });
      const fs = await import('node:fs/promises');
      const os = await import('node:os');
      const path = await import('node:path');
      nameForType = loaded.fileName ?? mediaPath;
      // Never build a path from the remote-supplied filename (path traversal):
      // strip to a sanitized basename and add entropy for uniqueness.
      const safeName = path.basename(loaded.fileName ?? 'file').replace(/[^A-Za-z0-9._-]/g, '_');
      const rand = Math.round(Math.random() * 1e9);
      tmpToCleanup = path.join(os.tmpdir(), `max-media-${Date.now()}-${rand}-${safeName}`);
      await fs.writeFile(tmpToCleanup, loaded.buffer);
      uploadSource = tmpToCleanup;
    }

    // Detect media type from the file name (strip any query string)
    const ext = nameForType.split('?')[0].split('.').pop()?.toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext ?? '')) {
      mediaType = 'image';
    } else if (['mp4', 'mov', 'avi'].includes(ext ?? '')) {
      mediaType = 'video';
    } else if (['mp3', 'wav', 'ogg'].includes(ext ?? '')) {
      mediaType = 'audio';
    }
  }

  // Upload media; remove the temp file once the upload token is obtained.
  const uploadResult = await api
    .uploadMedia(mediaType, uploadSource, inlineMime)
    .finally(async () => {
      if (tmpToCleanup) {
        const fs = await import('node:fs/promises');
        await fs.unlink(tmpToCleanup).catch(() => {});
      }
    });

  // Build attachment — MAX requires token from upload response
  const attachments: (MaxAttachment | MaxInlineKeyboardAttachment)[] = [
    {
      type:
        mediaType === 'image'
          ? 'image'
          : mediaType === 'video'
            ? 'video'
            : mediaType === 'audio'
              ? 'audio'
              : 'file',
      payload: { token: uploadResult.token },
    },
  ];

  // Add inline keyboard if present
  if (opts.buttons?.length) {
    attachments.push(buildInlineKeyboard(opts.buttons));
  }

  // Caption may exceed MAX's 4000-char limit; keep the first chunk on the media
  // and send the rest as follow-up messages. The chunker is fetched lazily so
  // the (common) no-overflow path needs no runtime.
  const { mediaCaption, followups } = splitMediaCaption(caption, (text, limit) =>
    getMaxRuntime().channel.text.chunkMarkdownText(text, limit),
  );

  const body: MaxNewMessageBody = {
    text: mediaCaption || undefined,
    format: opts.format ?? undefined,
    notify: opts.notify,
    attachments,
  };

  if (opts.replyToMessageId) {
    body.link = { type: 'reply', mid: opts.replyToMessageId };
  }

  const chatId = normalizeTargetId(to);
  const params: { chat_id?: number; user_id?: number; disable_link_preview?: boolean } = {
    chat_id: chatId,
  };

  if (opts.disableLinkPreview) {
    params.disable_link_preview = true;
  }

  const result = await api.sendMessage(body, params);

  // Deliver the overflow remainder as follow-up text messages.
  for (const followup of followups) {
    await api.sendMessage(
      { text: followup, format: opts.format ?? undefined, notify: opts.notify },
      { chat_id: chatId },
    );
  }

  return {
    messageId: result.message?.body?.mid ?? '',
    raw: result,
  };
}

/**
 * Send a contact attachment to MAX.
 */
export async function sendMaxContact(
  to: string,
  contact: { name: string; contactId?: number; vcfPhone?: string; vcfInfo?: string },
  opts: MaxSendOptions = {},
): Promise<{ messageId: string; raw: MaxSendResult }> {
  const api = new MaxApi(resolveApiOptions(opts));

  // MAX contact attachment payload uses snake_case (contact_id / vcf_info /
  // vcf_phone) and requires `name`. Requires either contact_id (MAX user_id)
  // or vcf_info (VCard string); without either → 400 "Missing info for contact".
  const payload: Record<string, unknown> = { name: contact.name };
  if (contact.contactId != null) {
    payload.contact_id = contact.contactId;
    if (contact.vcfPhone) payload.vcf_phone = contact.vcfPhone;
  } else if (contact.vcfInfo) {
    payload.vcf_info = contact.vcfInfo;
  } else {
    // Generate VCard from name + phone
    // Use literal \n escape sequence for JSON serialization
    const vcfParts = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${contact.name}`];
    if (contact.vcfPhone) vcfParts.push(`TEL:${contact.vcfPhone}`);
    vcfParts.push('END:VCARD');
    payload.vcf_info = vcfParts.join('\n');
  }

  const attachment: MaxAttachment = {
    type: 'contact',
    payload,
  };

  const body: MaxNewMessageBody = {
    text: opts.disableLinkPreview ? undefined : undefined, // no separate text for contact
    attachments: [attachment],
    notify: opts.notify,
  };

  if (opts.replyToMessageId) {
    body.link = { type: 'reply', mid: opts.replyToMessageId };
  }

  const chatId = normalizeTargetId(to);
  const result = await api.sendMessage(body, { chat_id: chatId });

  return {
    messageId: result.message?.body?.mid ?? '',
    raw: result,
  };
}

/**
 * Send a location attachment to MAX.
 */
export async function sendMaxLocation(
  to: string,
  location: { latitude: number; longitude: number },
  text?: string,
  opts: MaxSendOptions = {},
): Promise<{ messageId: string; raw: MaxSendResult }> {
  const api = new MaxApi(resolveApiOptions(opts));

  const attachment: MaxAttachment = {
    type: 'location',
    latitude: location.latitude,
    longitude: location.longitude,
  };

  const body: MaxNewMessageBody = {
    text: text || undefined,
    attachments: [attachment],
    format: opts.format ?? undefined,
    notify: opts.notify,
  };

  if (opts.replyToMessageId) {
    body.link = { type: 'reply', mid: opts.replyToMessageId };
  }

  const chatId = normalizeTargetId(to);
  const result = await api.sendMessage(body, { chat_id: chatId });

  return {
    messageId: result.message?.body?.mid ?? '',
    raw: result,
  };
}

/**
 * Send a sticker to MAX by sticker code.
 * Sticker codes come from incoming sticker attachments (payload.code).
 */
export async function sendMaxSticker(
  to: string,
  stickerCode: string,
  opts: MaxSendOptions = {},
): Promise<{ messageId: string; raw: MaxSendResult }> {
  const api = new MaxApi(resolveApiOptions(opts));

  const stickerAttachment: MaxStickerAttachment = {
    type: 'sticker',
    payload: { code: stickerCode },
  };

  const body: MaxNewMessageBody = {
    attachments: [stickerAttachment],
    notify: opts.notify,
  };

  if (opts.replyToMessageId) {
    body.link = { type: 'reply', mid: opts.replyToMessageId };
  }

  const chatId = normalizeTargetId(to);
  const params: { chat_id?: number; disable_link_preview?: boolean } = {
    chat_id: chatId,
  };

  const result = await api.sendMessage(body, params);

  return {
    messageId: result.message?.body?.mid ?? '',
    raw: result,
  };
}
