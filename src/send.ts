/**
 * Outbound message sending for MAX.
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';

import { resolveMaxAccount } from './accounts.js';
import { getMaxRuntime } from './runtime.js';
import {
  MaxApi,
  type MaxAttachment,
  type MaxInlineKeyboardAttachment,
  type MaxNewMessageBody,
  type MaxSendResult,
  type MaxStickerAttachment,
} from './api.js';

export type MaxSendButton = {
  text: string;
  payload?: string;
  callback_data?: string;
  url?: string;
};

export interface MaxSendOptions {
  token?: string;
  accountId?: string;
  cfg?: OpenClawConfig;
  replyToMessageId?: string;
  format?: 'markdown' | 'html';
  disableLinkPreview?: boolean;
  notify?: boolean;
  buttons?: MaxSendButton[][];
}

/**
 * Resolve a token from options or config.
 */
function resolveToken(opts: MaxSendOptions): string {
  if (opts.token) return opts.token;
  if (opts.cfg) {
    const account = resolveMaxAccount({ cfg: opts.cfg, accountId: opts.accountId });
    if (account.token) return account.token;
  }
  throw new Error('MAX bot token not available');
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
        .map((button) => ({
          text: String(button.text ?? button.label ?? ''),
          payload: button.payload != null ? String(button.payload) : undefined,
          callback_data: button.callback_data != null ? String(button.callback_data) : undefined,
          url: button.url != null ? String(button.url) : undefined,
        }))
        .filter((button) => button.text.trim().length > 0);
    })
    .filter((row) => row.length > 0);

  return rows.length > 0 ? rows : undefined;
}

/**
 * Send a text message to a MAX chat or user.
 */
function buildInlineKeyboard(buttons: MaxSendButton[][]): MaxInlineKeyboardAttachment {
  return {
    type: 'inline_keyboard',
    payload: {
      buttons: buttons.map((row) =>
        row.map((btn) => {
          if (btn.url) {
            return { type: 'link' as const, text: btn.text, url: btn.url };
          }
          return {
            type: 'callback' as const,
            text: btn.text,
            payload: btn.payload ?? btn.callback_data ?? btn.text,
          };
        }),
      ),
    },
  };
}

function buildMaxTextBody(text: string, opts: MaxSendOptions = {}): MaxNewMessageBody {
  const body: MaxNewMessageBody = {
    text: text || undefined,
    format: opts.format ?? undefined,
    notify: opts.notify,
  };

  // Reply context
  if (opts.replyToMessageId) {
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
  const token = resolveToken(opts);
  const api = new MaxApi({ token });

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
  opts: MaxSendOptions = {},
): Promise<void> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });
  const body = buildMaxTextBody(text, opts);
  await api.answerCallback(callbackId, { message: body });
}

/**
 * Edit an existing MAX message.
 */
export async function editMaxMessage(
  messageId: string,
  text: string,
  opts: MaxSendOptions = {},
): Promise<void> {
  const token = resolveToken(opts);
  const api = new MaxApi({ token });

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
  const token = resolveToken(opts);
  const api = new MaxApi({ token });

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
  const token = resolveToken(opts);
  const api = new MaxApi({ token });

  // uploadMedia reads string sources from disk, so a remote http(s) URL must be
  // downloaded to a temp file first (channel.ts passes through remote mediaUrls).
  let uploadPath = mediaPath;
  let nameForType = mediaPath;
  let tmpToCleanup: string | undefined;
  if (/^https?:\/\//i.test(mediaPath)) {
    const maxBytes = ((opts as { mediaMaxMb?: number }).mediaMaxMb ?? 20) * 1024 * 1024;
    const loaded = await getMaxRuntime().channel.media.fetchRemoteMedia({ url: mediaPath, maxBytes });
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    nameForType = loaded.fileName ?? mediaPath;
    tmpToCleanup = path.join(os.tmpdir(), `max-media-${Date.now()}-${loaded.fileName ?? 'file'}`);
    await fs.writeFile(tmpToCleanup, loaded.buffer);
    uploadPath = tmpToCleanup;
  }

  // Detect media type from the file name (strip any query string)
  const ext = nameForType.split('?')[0].split('.').pop()?.toLowerCase();
  let mediaType: 'image' | 'video' | 'audio' | 'file' = 'file';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext ?? '')) {
    mediaType = 'image';
  } else if (['mp4', 'mov', 'avi'].includes(ext ?? '')) {
    mediaType = 'video';
  } else if (['mp3', 'wav', 'ogg'].includes(ext ?? '')) {
    mediaType = 'audio';
  }

  // Upload media; remove the temp file once the upload token is obtained.
  const uploadResult = await api.uploadMedia(mediaType, uploadPath).finally(async () => {
    if (tmpToCleanup) {
      const fs = await import('node:fs/promises');
      await fs.unlink(tmpToCleanup).catch(() => {});
    }
  });

  // Build attachment — MAX requires token from upload response
  const attachments: MaxAttachment[] = [
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
    attachments.push({
      type: 'inline_keyboard',
      payload: {
        buttons: opts.buttons.map((row) =>
          row.map((btn) => {
            if (btn.url) {
              return { type: 'link' as const, text: btn.text, url: btn.url };
            }
            return {
              type: 'callback' as const,
              text: btn.text,
              payload: btn.payload ?? btn.callback_data ?? btn.text,
            };
          }),
        ),
      },
    });
  }

  const body: MaxNewMessageBody = {
    text: caption || undefined,
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
  const token = resolveToken(opts);
  const api = new MaxApi({ token });

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
  const token = resolveToken(opts);
  const api = new MaxApi({ token });

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
  const token = resolveToken(opts);
  const api = new MaxApi({ token });

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
