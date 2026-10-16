/**
 * MAX long-polling monitor — receives updates and dispatches them to OpenClaw.
 *
 * Uses the same inbound pipeline as other channel plugins:
 * finalizeInboundContext → dispatchReplyWithBufferedBlockDispatcher
 */

import type { ChannelLogSink } from 'openclaw/plugin-sdk/channel-contract';
import {
  type ChannelInboundMediaInput,
  toInboundMediaFacts,
} from 'openclaw/plugin-sdk/channel-inbound';
import { createReplyPrefixOptions } from 'openclaw/plugin-sdk/channel-outbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';

import type { ResolvedMaxAccount } from './accounts.js';
import type { MaxApi } from './api.js';
import {
  MaxApiError,
  type MaxCallback,
  type MaxMessage,
  type MaxUpdate,
  type MaxUser,
} from './api.js';
import {
  flushChatRegistry,
  getChatTitle,
  markTitleFetched,
  needsTitle,
  removeChat,
  setChatMeta,
  upsertChat,
} from './chat-registry.js';
import { getMaxRuntime } from './runtime.js';
import {
  answerMaxCallback,
  editMaxMessage,
  readMaxChannelButtons,
  sendMaxMediaMessage,
  sendMaxMessage,
} from './send.js';
import { rememberStickerCode } from './sticker-cache.js';
import { MAX_SUBSCRIBED_UPDATE_TYPES } from './types.js';
import {
  type MaxWebhookTarget,
  registerMaxWebhookTarget,
  resolveMaxWebhookPath,
  subscribeMaxWebhook,
  unsubscribeMaxWebhook,
} from './webhook.js';

export interface MaxMonitorOptions {
  api: MaxApi;
  account: ResolvedMaxAccount;
  config: OpenClawConfig;
  abortSignal: AbortSignal;
  botUserId?: number;
  botUsername?: string;
  log?: ChannelLogSink;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}

export async function startMaxPolling(opts: MaxMonitorOptions): Promise<void> {
  const { account } = opts;

  // Check if webhook mode is configured
  const webhookUrl = account.config.webhookUrl?.trim();
  const useWebhook = Boolean(webhookUrl);

  if (useWebhook) {
    // Webhook mode
    await startMaxWebhook({ ...opts, webhookUrl: webhookUrl! });
  } else {
    // Polling mode
    await startMaxPollingLoop(opts);
  }
}

async function startMaxPollingLoop(opts: MaxMonitorOptions): Promise<void> {
  const { api, account, abortSignal, log } = opts;
  let marker: number | null = null;
  let consecutiveErrors = 0;

  log?.info(`[${account.accountId}] MAX long-polling started`);
  seedChatsFromConfig(account); // once, outside the reconnect loop

  try {
    while (!abortSignal.aborted) {
      try {
        const resp = await api.getUpdates(
          {
            timeout: 30,
            marker: marker ?? undefined,
            types: [...MAX_SUBSCRIBED_UPDATE_TYPES],
          },
          abortSignal,
        );

        consecutiveErrors = 0;

        if (resp.marker != null) {
          marker = resp.marker;
        }

        for (const update of resp.updates) {
          if (abortSignal.aborted) break;
          try {
            await dispatchUpdate(update, opts);
          } catch (err) {
            log?.error(
              `[${account.accountId}] Error dispatching update ${update.update_type}: ${String(err)}`,
            );
          }
        }
      } catch (err) {
        if (abortSignal.aborted) break;

        // Fatal auth error: stop polling instead of hammering with a bad token.
        const status = err instanceof MaxApiError ? err.status : undefined;
        if (status === 401 || status === 403) {
          log?.error(`[${account.accountId}] Polling stopped: auth error ${status}`);
          break;
        }

        consecutiveErrors += 1;

        // A stale marker can wedge the loop; drop it after repeated failures.
        if (consecutiveErrors >= 3 && marker != null) {
          log?.error(
            `[${account.accountId}] Resetting poll marker after ${consecutiveErrors} consecutive errors`,
          );
          marker = null;
        }

        // Exponential backoff with jitter, capped at 30s (longer base on 429).
        const base = status === 429 ? 5000 : 1000;
        const delay = Math.min(base * 2 ** (consecutiveErrors - 1), 30_000);
        const jitter = Math.round(Math.random() * 500);
        log?.error(
          `[${account.accountId}] Polling error (#${consecutiveErrors}, status=${status ?? 'n/a'}); retry in ${delay}ms: ${String(err)}`,
        );
        await sleep(delay + jitter);
      }
    }
  } finally {
    flushChatRegistry(account.accountId); // dump debounced writes before exit
  }

  log?.info(`[${account.accountId}] MAX long-polling stopped`);
}

async function startMaxWebhook(opts: MaxMonitorOptions & { webhookUrl: string }): Promise<void> {
  const { api, account, config, abortSignal, log, webhookUrl } = opts;

  const webhookPath = resolveMaxWebhookPath(account.config.webhookPath, account.config.webhookUrl);
  const webhookSecret = account.config.webhookSecret?.trim();

  log?.info(`[${account.accountId}] MAX webhook mode: ${webhookUrl} (path: ${webhookPath})`);
  seedChatsFromConfig(account); // once at start

  // Register webhook handler
  const target: MaxWebhookTarget = {
    account,
    config,
    path: webhookPath,
    secret: webhookSecret,
    onUpdate: async (update) => {
      try {
        await dispatchUpdate(update, opts);
      } catch (err) {
        log?.error(`[${account.accountId}] Webhook update dispatch failed: ${String(err)}`);
      }
    },
    log: (msg) => log?.info?.(msg),
    error: (msg) => log?.error?.(msg),
  };

  const unregister = registerMaxWebhookTarget(target);

  // Subscribe to webhook
  try {
    await subscribeMaxWebhook({
      api,
      webhookUrl,
      secret: webhookSecret,
    });
    log?.info(`[${account.accountId}] MAX webhook subscribed: ${webhookUrl}`);
  } catch (err) {
    log?.error(`[${account.accountId}] MAX webhook subscription failed: ${String(err)}`);
    unregister();
    throw err;
  }

  // Wait for abort signal
  await new Promise<void>((resolve) => {
    const checkAbort = () => {
      if (abortSignal.aborted) {
        resolve();
      } else {
        setTimeout(checkAbort, 1000);
      }
    };
    checkAbort();
  });

  // Unsubscribe on stop
  try {
    await unsubscribeMaxWebhook({ api, webhookUrl });
    log?.info(`[${account.accountId}] MAX webhook unsubscribed`);
  } catch (err) {
    log?.error(`[${account.accountId}] MAX webhook unsubscribe failed: ${String(err)}`);
  }

  unregister();
  flushChatRegistry(account.accountId); // dump debounced writes before exit
  log?.info(`[${account.accountId}] MAX webhook mode stopped`);
}

// ── Dispatch ──

/** @internal - Exported for testing only. */
export async function dispatchUpdate(update: MaxUpdate, opts: MaxMonitorOptions): Promise<void> {
  const { log, account, statusSink } = opts;

  switch (update.update_type) {
    case 'message_created': {
      if (!update.message) {
        // MAX violates its own OpenAPI contract (message is required) for
        // native voice notes in long polling: the bot receives a
        // bodyless message_created with no message/chat_id/mid, and the note
        // never appears in chat history either. There is nothing the plugin
        // can act on (not even a chat to reply to) — this is a MAX platform
        // limitation of that delivery path; webhooks can deliver native audio.
        // Forwarded/attached audio FILES do arrive normally (as
        // type:"file"). Logged so the silent drop is visible during debugging.
        log?.warn?.(
          `[${account.accountId}] message_created without message — likely a native voice note (try webhook delivery instead of polling); skipping`,
        );
        break;
      }
      // Record the chat in the registry before any skip — knowing a group/channel
      // exists must not depend on who sent the message or on policy gates.
      recordInboundChat(update.message, opts);
      // Skip messages from the bot itself
      if (opts.botUserId && update.message.sender?.user_id === opts.botUserId) break;
      statusSink?.({ lastInboundAt: Date.now() });
      // mark_seen / typing are sent inside processIncomingMessage only AFTER the
      // sender passes policy checks (avoid leaking presence to blocked users).
      await processIncomingMessage(update.message, update.user_locale, opts);
      break;
    }

    case 'message_callback': {
      if (!update.callback) break;
      statusSink?.({ lastInboundAt: Date.now() });
      // The original message (carrying recipient.chat_id) is a SIBLING of
      // `callback` on the update, not nested inside it — pass it through so the
      // reply targets the real chat instead of falling back to the user_id.
      await processCallback(update.callback, update.message, opts);
      break;
    }

    case 'message_edited': {
      if (!update.message) break;
      // Register the chat before any skip / clone (see message_created).
      recordInboundChat(update.message, opts);
      // Skip edits from the bot itself
      if (opts.botUserId && update.message.sender?.user_id === opts.botUserId) break;
      log?.debug?.(
        `[${account.accountId}] Message edited: ${update.message?.body?.mid} text="${update.message?.body?.text ?? '<null>'}" hasBody=${!!update.message?.body}`,
      );
      statusSink?.({ lastInboundAt: Date.now() });
      // mark_seen / typing are sent inside processIncomingMessage after policy checks.
      // Process edited message through the same pipeline as new messages.
      // Use a unique mid suffix to avoid OpenClaw dedup (same mid = skipped).
      const editedMessage = { ...update.message };
      const originalMid = editedMessage.body.mid;
      editedMessage.body = {
        ...editedMessage.body,
        mid: `${originalMid}_edited_${update.timestamp}`,
      };

      // MAX message_edited may not include text — fetch it from API if missing
      if (!editedMessage.body.text?.trim() && originalMid) {
        try {
          const chatId = editedMessage.recipient?.chat_id;
          if (chatId) {
            const fetched = await opts.api.getMessages(chatId, {
              message_ids: [originalMid],
              count: 1,
            });
            const fetchedMsg = fetched.messages?.[0];
            if (fetchedMsg?.body?.text) {
              editedMessage.body = { ...editedMessage.body, text: fetchedMsg.body.text };
              if (fetchedMsg.body.attachments?.length) {
                editedMessage.body.attachments = fetchedMsg.body.attachments;
              }
              log?.debug?.(
                `[${account.accountId}] Fetched edited text: "${fetchedMsg.body.text.slice(0, 50)}"`,
              );
            }
          }
        } catch (err) {
          log?.debug?.(
            `[${account.accountId}] Failed to fetch edited message text: ${String(err)}`,
          );
        }
      }

      await processIncomingMessage(editedMessage, update.user_locale, opts);
      break;
    }

    case 'bot_started': {
      if (!update.user) break;
      log?.info(`[${account.accountId}] Bot started by user ${update.user.user_id}`);
      statusSink?.({ lastInboundAt: Date.now() });
      await processBotStarted(update.user, update.chat_id, opts);
      break;
    }

    case 'bot_added': {
      const chatId = update.chat_id;
      log?.info(`[${account.accountId}] Bot added to chat ${chatId}`);
      if (chatId != null) {
        upsertChat(account.accountId, {
          chatId,
          kind: update.is_channel ? 'channel' : 'group',
          seenAt: update.timestamp || Date.now(),
        });
        await maybeFetchChatMeta(chatId, opts);
      }
      break;
    }

    case 'bot_removed': {
      const chatId = update.chat_id;
      log?.info(`[${account.accountId}] Bot removed from chat ${chatId}`);
      if (chatId != null) removeChat(account.accountId, chatId);
      break;
    }

    case 'chat_title_changed': {
      const chatId = update.chat_id;
      const title = typeof update.title === 'string' ? update.title : undefined;
      if (chatId != null && title) setChatMeta(account.accountId, chatId, { title });
      break;
    }

    default:
      log?.debug?.(`[${account.accountId}] Unhandled update type: ${update.update_type}`);
  }
}

// ── Process messages through OpenClaw pipeline ──

/**
 * Process incoming MAX message through OpenClaw pipeline.
 * @internal - Exported for testing only
 */
export async function processIncomingMessage(
  message: MaxMessage,
  userLocale: string | null | undefined,
  opts: MaxMonitorOptions,
): Promise<void> {
  const { account, config, log, statusSink } = opts;
  const core = getMaxRuntime();

  const senderId = message.sender?.user_id;
  const senderName = formatSenderName(message.sender);
  const senderUsername = message.sender?.username ?? undefined;

  // Determine chat type and IDs
  const chatId = message.recipient.chat_id;
  const chatType = message.recipient.chat_type; // "dialog", "chat", "channel"
  const isGroup = chatType === 'chat' || chatType === 'channel';

  const rawText = message.body.text ?? '';
  const messageId = message.body.mid;
  const isCallbackCommand =
    (message as MaxMessage & { __maxCallback?: boolean }).__maxCallback === true;
  const attachments = message.body.attachments ?? [];

  // Forwarded messages: MAX leaves body.text empty and puts the forwarded text
  // in link.message (sent flat as `{mid, text}`) plus the origin author/chat in
  // `link`. Extract both so the forward isn't seen as empty and the agent gets
  // the content with attribution.
  const forwardedLink = message.link?.type === 'forward' ? message.link : undefined;
  const forwardedMsg = forwardedLink?.message as
    { text?: string; body?: { text?: string } } | undefined;
  const forwardedText = (forwardedMsg?.text ?? forwardedMsg?.body?.text ?? '').trim();
  const forwardOrigin = forwardedLink
    ? (forwardedLink.sender?.first_name ??
      (forwardedLink.chat_id != null
        ? // Prefer a known chat/channel title from the registry (for chats the
          // bot is in); fall back to the raw id for external channels.
          (getChatTitle(account.accountId, forwardedLink.chat_id) ??
          `chat ${forwardedLink.chat_id}`)
        : 'channel'))
    : undefined;

  log?.debug?.(
    `[${account.accountId}] Processing message: mid=${messageId} chatId=${message.recipient.chat_id} chatType=${message.recipient.chat_type} senderId=${message.sender?.user_id} text="${rawText.slice(0, 50)}" attachments=${attachments.length}`,
  );

  // Process attachments: download media, build descriptions for non-downloadable types
  const attachmentDescriptions: string[] = [];
  const media: ChannelInboundMediaInput[] = [];

  for (const att of attachments) {
    const attType = att.type ?? 'unknown';
    const payload = att.payload as Record<string, unknown> | undefined;

    // Media types with downloadable URL: image, sticker, video, audio, file
    if (['image', 'sticker', 'video', 'audio', 'file'].includes(attType)) {
      // For stickers, always capture the code for outbound use
      const stickerCode = attType === 'sticker' ? ((payload?.code ?? '') as string) : '';
      if (stickerCode) {
        log?.debug?.(`[${account.accountId}] Sticker received: code=${stickerCode}`);
        attachmentDescriptions.push(`[Sticker: code=${stickerCode}]`);
        if (chatId != null) {
          rememberStickerCode(chatId, stickerCode);
        }
      }

      const url = (payload?.url ?? (att as Record<string, unknown>).url ?? '') as string;
      if (url && typeof url === 'string' && url.startsWith('http')) {
        try {
          const maxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
          const saved = await core.channel.media.saveRemoteMedia({
            url,
            maxBytes,
            subdir: 'inbound',
          });
          media.push({
            path: saved.path,
            contentType: saved.contentType,
            fileName: saved.fileName,
            messageId,
          });
        } catch (err) {
          log?.error?.(`[${account.accountId}] Failed to download ${attType}: ${String(err)}`);
          // Fall back to text description (sticker code already added above)
          if (attType !== 'sticker') {
            attachmentDescriptions.push(`[${attType}: ${url}]`);
          }
        }
      } else {
        // No URL — text description
        if (attType === 'sticker') {
          const code = payload?.code ?? '';
          attachmentDescriptions.push(`[Sticker${code ? `: ${code}` : ''}]`);
        } else if (attType === 'file') {
          const filename = (att as Record<string, unknown>).filename ?? payload?.filename ?? '';
          attachmentDescriptions.push(`[File${filename ? `: ${filename}` : ''}]`);
        } else {
          attachmentDescriptions.push(`[${attType}]`);
        }
      }
    } else if (attType === 'share') {
      const url = (payload?.url ?? (att as Record<string, unknown>).url ?? '') as string;
      attachmentDescriptions.push(`[Share${url ? `: ${url}` : ''}]`);
    } else if (attType === 'location') {
      const lat = (att as Record<string, unknown>).latitude ?? payload?.latitude ?? '';
      const lon = (att as Record<string, unknown>).longitude ?? payload?.longitude ?? '';
      attachmentDescriptions.push(`[Location: ${lat}, ${lon}]`);
    } else if (attType === 'contact') {
      const name = payload?.name ?? payload?.vcf_info ?? '';
      attachmentDescriptions.push(`[Contact${name ? `: ${name}` : ''}]`);
    } else if (attType !== 'inline_keyboard') {
      attachmentDescriptions.push(`[${attType}]`);
    }
  }

  const attachmentText = attachmentDescriptions.join(' ');
  const hasMedia = media.length > 0;
  const effectiveText = rawText.trim() || attachmentText || forwardedText;

  // Skip truly empty messages (no text, no media, no meaningful attachments)
  if (!effectiveText && !hasMedia) return;

  // Check for reply context
  const replyToId = message.link?.type === 'reply' ? message.link.message?.body?.mid : undefined;

  // Check for bot mention in group chats
  let wasMentioned: boolean | undefined;
  if (isGroup && opts.botUsername) {
    // MAX doesn't have annotation-based mentions like Google Chat,
    // so we check if the text contains @botname
    const mentionPattern = new RegExp(`@${opts.botUsername}\\b`, 'i');
    wasMentioned = mentionPattern.test(rawText);

    // Reply to bot's message also counts as mention (like Telegram behavior)
    if (!wasMentioned && message.link?.type === 'reply') {
      const replySender = message.link.sender;
      if (replySender?.is_bot && replySender?.user_id === opts.botUserId) {
        wasMentioned = true;
        log?.debug?.(`[${account.accountId}] Reply to bot message treated as mention`);
      }
    }
  }

  // DM security: check pairing/allowlist
  if (!isGroup) {
    const dmPolicy = account.config.dmPolicy ?? 'pairing';
    if (dmPolicy === 'disabled') {
      log?.debug?.(`[${account.accountId}] Blocked DM from ${senderId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== 'open') {
      const configAllowFrom = (account.config.allowFrom ?? []).map(String);
      const storeAllowFrom = await core.channel.pairing
        .readAllowFromStore({ channel: 'max', accountId: account.accountId })
        .catch(() => []);
      const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];

      const senderStr = String(senderId);
      const allowed = effectiveAllowFrom.includes(senderStr) || effectiveAllowFrom.includes('*');

      if (!allowed) {
        if (dmPolicy === 'pairing') {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: 'max',
            id: senderStr,
            accountId: account.accountId,
            meta: { name: senderName },
          });
          if (created) {
            log?.info(`[${account.accountId}] Pairing request from ${senderStr}`);
            try {
              const pairingReply = core.channel.pairing.buildPairingReply({
                channel: 'max',
                idLine: `Your MAX user id: ${senderStr}`,
                code,
              });
              await sendMaxMessage(String(chatId ?? senderId), pairingReply, {
                token: account.token,
              });
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              log?.error(`[${account.accountId}] Pairing reply failed: ${String(err)}`);
            }
          }
        }
        return;
      }
    }
  }

  // Group policy
  if (isGroup) {
    const defaultGroupPolicy = config.channels?.defaults?.groupPolicy;
    const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? 'allowlist';

    if (groupPolicy === 'disabled') {
      log?.debug?.(`[${account.accountId}] Blocked group message (groupPolicy=disabled)`);
      return;
    }

    // For allowlist policy, check if chat is in the groups config
    if (groupPolicy === 'allowlist') {
      const groups = account.config.groups ?? {};
      const chatIdStr = String(chatId);
      const hasWildcard = '*' in groups;
      const chatAllowed = chatIdStr in groups || hasWildcard;
      if (!chatAllowed) {
        log?.debug?.(
          `[${account.accountId}] Blocked group message (not in allowlist, chat=${chatIdStr})`,
        );
        return;
      }

      // Enforce the sender allowlist when one is configured (per-group
      // allowFrom, else account-level groupAllowFrom). When none is set, any
      // member of an allowed chat passes (still mention-gated below).
      const groupCfg = groups[chatIdStr] ?? groups['*'];
      const senderAllow = (
        (groupCfg?.allowFrom ?? account.config.groupAllowFrom ?? []) as Array<string | number>
      ).map(String);
      if (senderAllow.length > 0) {
        const senderStr = String(senderId);
        if (!senderAllow.includes(senderStr) && !senderAllow.includes('*')) {
          log?.debug?.(
            `[${account.accountId}] Blocked group message (sender ${senderStr} not in groupAllowFrom)`,
          );
          return;
        }
      }
    }

    // Require mention in groups
    const groupCfg = account.config.groups?.[String(chatId)] ?? account.config.groups?.['*'];
    const requireMention = groupCfg?.requireMention ?? true;
    if (requireMention && !wasMentioned) {
      log?.debug?.(`[${account.accountId}] Skipping group message (not mentioned)`);
      return;
    }
  }

  // Sender passed all policy checks — mark the message read now (kept after the
  // checks to avoid leaking presence to blocked users). The typing indicator is
  // driven by the reply dispatcher keepalive below.
  if (chatId != null) {
    opts.api.sendAction(chatId, 'mark_seen').catch((err) => {
      log?.debug?.(`[${account.accountId}] mark_seen failed: ${String(err)}`);
    });
  }

  // Direct-message bindings identify people by user_id; MAX's chat_id is a
  // separate delivery address and must remain the target for replies.
  const chatIdStr = String(chatId ?? senderId);
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: 'max',
    accountId: account.accountId,
    peer: {
      kind: isGroup ? 'group' : 'direct',
      id: isGroup ? chatIdStr : String(senderId ?? chatId),
    },
  });

  // Build context
  // For groups, prefer the human-readable title (kept fresh by the chat
  // registry, incl. chat_title_changed) so the agent sees the group name, not
  // just a numeric id — matching the Telegram channel's "<title> id:<id>"
  // format. Falls back to chat:<id> until the title is known.
  const groupTitle =
    isGroup && chatId != null ? getChatTitle(account.accountId, chatId) : undefined;
  const fromLabel = isGroup
    ? groupTitle
      ? `${groupTitle} id:${chatIdStr}`
      : `chat:${chatIdStr}`
    : senderName || `user:${senderId}`;

  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // Combine text and attachment descriptions for the agent
  const combinedBody = attachmentText
    ? rawText.trim()
      ? `${rawText.trim()}\n${attachmentText}`
      : attachmentText
    : rawText;

  // Forwarded message: prepend attribution, then the forwarded text (from
  // link.message, since body.text is empty), then any comment/attachments the
  // forwarder added. forwardOrigin/forwardedText are resolved above.
  const bodyForAgent = forwardOrigin
    ? `[Forwarded from ${forwardOrigin}]\n${[forwardedText, combinedBody.trim()]
        .filter(Boolean)
        .join('\n')}`
    : combinedBody;

  const body = core.channel.reply.formatAgentEnvelope({
    channel: 'MAX',
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: bodyForAgent,
  });

  // Detect text-slash commands (user types /status, /models, /reasoning etc.)
  const rawTextTrimmed = (rawText || '').trim();
  const isTextSlashCommand = rawTextTrimmed.startsWith('/');

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: bodyForAgent,
    RawBody: rawText,
    CommandBody: rawText || attachmentText,
    From: `max:${senderId}`,
    To: `max:${chatIdStr}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? 'group' : 'direct',
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId != null ? String(senderId) : undefined,
    SenderUsername: senderUsername,
    WasMentioned: isGroup ? wasMentioned : undefined,
    Provider: 'max',
    Surface: 'max',
    MessageSid: messageId,
    MessageSidFull: messageId,
    ReplyToId: replyToId,
    ReplyToIdFull: replyToId,
    OriginatingChannel: 'max',
    OriginatingTo: `max:${chatIdStr}`,
    // Media attachments (downloaded to local paths), in attachment order
    media: hasMedia ? toInboundMediaFacts(media) : undefined,
    // Text-slash command detection: treat /status, /models etc. as text commands
    // so OpenClaw routes them through handleCommands instead of silently dropping
    // Text-slash command detection: treat /status, /models etc. as text commands
    // so OpenClaw routes them through handleCommands instead of silently dropping.
    // The core only executes a text-slash turn when authorized === true (an
    // undefined/false value degrades to "unauthorized" and the command reply is
    // never produced). Any sender reaching this point has already cleared every
    // DM/group allowlist + mention gate above, so the command is authorized.
    ...(isTextSlashCommand
      ? {
          CommandSource: 'text' as const,
          CommandAuthorized: true,
          CommandTurn: {
            kind: 'text-slash' as const,
            source: 'text' as const,
            authorized: true,
            body: rawTextTrimmed,
          },
        }
      : {}),
  });

  // Record session meta
  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      log?.error(`[${account.accountId}] Failed updating session meta: ${String(err)}`);
    });

  // Dispatch through the standard reply pipeline
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: 'max',
    accountId: route.accountId,
  });

  // Typing indicator while the agent processes. MAX's "typing_on" action
  // expires after a few seconds, so it must be re-fired to stay visible.
  // The host's TypingController already drives that keepalive: it calls
  // onReplyStart on an interval for the whole turn and stops only when the
  // run is complete and the dispatch queue is empty.
  //
  // Do NOT wrap this in createTypingCallbacks: that helper's onIdle seals
  // typing permanently on the first dispatch pause (pending===0), which the
  // dispatcher hits repeatedly while streaming text or generating media —
  // making the indicator flicker and die mid-turn. Passing a bare
  // onReplyStart lets the host controller own the lifecycle correctly.
  const onReplyStart =
    chatId != null
      ? async () => {
          try {
            await opts.api.sendAction(chatId, 'typing_on');
          } catch (err) {
            log?.debug?.(`[${account.accountId}] typing_on failed: ${String(err)}`);
          }
        }
      : undefined;

  // Streaming modes: "partial" = edit single message, "block" = each block as separate message
  const streamMode = account.config.streamMode ?? 'off';
  const useEditStreaming = streamMode === 'partial';
  const useBlockStreaming = streamMode === 'block';
  const replyMid = isCallbackCommand ? undefined : messageId.replace(/_edited_\d+$/, '');
  // Callbacks are acknowledged immediately in processCallback (spinner clear +
  // toast). The reply is then delivered as a normal message — NOT via /answers —
  // so we never answer the same callback_id twice (the second would 400 and the
  // reply has no /answers fallback). Hence no callbackId is threaded to delivery.
  const callbackId: string | undefined = undefined;

  // Draft stream for edit-streaming (like Telegram's partial reply approach)
  let draftMid: string | null = null;
  let draftLastText = '';
  let draftLastEditAt = 0;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let draftStopped = false;
  let draftQueue: Promise<void> = Promise.resolve();
  const DRAFT_THROTTLE_MS = 1200;
  const DRAFT_MAX_CHARS = 4000;
  const DRAFT_MIN_CHARS = 30; // Don't send until we have enough text

  // Partial callbacks are fire-and-forget. Serialize their network requests so
  // another chunk cannot create a second draft before the first POST returns.
  const draftUpdate = (text: string): Promise<void> => {
    draftQueue = draftQueue.then(() => writeDraft(text));
    return draftQueue;
  };

  const writeDraft = async (text: string) => {
    if (draftStopped || !text) return;
    const trimmed = text.trimEnd();
    if (!trimmed || trimmed === draftLastText) return;
    if (trimmed.length > DRAFT_MAX_CHARS) {
      draftStopped = true;
      return;
    }
    if (!draftMid && trimmed.length < DRAFT_MIN_CHARS) return; // wait for more text

    // Clear pending timer
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }

    const now = Date.now();
    const elapsed = now - draftLastEditAt;
    if (elapsed < DRAFT_THROTTLE_MS) {
      // Schedule a deferred update
      draftTimer = setTimeout(() => {
        draftUpdate(text);
      }, DRAFT_THROTTLE_MS - elapsed);
      return;
    }

    draftLastText = trimmed;
    draftLastEditAt = now;

    try {
      if (!draftMid) {
        // First chunk — send new message
        const res = await sendMaxMessage(chatIdStr, trimmed, {
          token: account.token,
          replyToMessageId: replyMid,
          format: 'markdown',
        });
        draftMid = res.messageId || null;
        statusSink?.({ lastOutboundAt: Date.now() });
      } else {
        // Edit existing message
        await editMaxMessage(draftMid, trimmed, {
          token: account.token,
          format: 'markdown',
        });
      }
    } catch (err) {
      draftStopped = true;
      log?.debug?.(`[${account.accountId}] MAX draft stream failed: ${String(err)}`);
    }
  };

  const draftClear = async () => {
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
    draftStopped = true;
    // A POST already in flight may still assign draftMid. Final delivery must
    // wait for it, while queued updates see draftStopped and do nothing.
    await draftQueue;
  };

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      ...(onReplyStart ? { onReplyStart } : {}),
      deliver: async (payload) => {
        if (useEditStreaming) await draftClear();
        const finalText = payload.text;
        // Edit-streaming finalize: replace the draft with the final text — but
        // only when it fits the single-message cap. A longer answer cannot be an
        // edit (MAX 400s at >DRAFT_MAX_CHARS), so it must fall through to chunked
        // delivery instead of being silently dropped.
        if (useEditStreaming && draftMid && finalText && finalText.length <= DRAFT_MAX_CHARS) {
          if (finalText.trimEnd() !== draftLastText) {
            try {
              await editMaxMessage(draftMid, finalText, {
                token: account.token,
                format: 'markdown',
              });
              draftLastText = finalText.trimEnd();
            } catch (err) {
              // Edit failed — fall back to chunked send so the reply isn't lost.
              log?.debug?.(
                `[${account.accountId}] draft finalize edit failed, falling back to send: ${String(err)}`,
              );
              await deliverMaxReply({
                payload,
                account,
                chatId: chatIdStr,
                replyToId: replyMid,
                callbackId,
                config,
                log,
                statusSink,
              });
            }
          }
          draftStopped = true;

          // Handle media if present
          if (payload.mediaUrls?.length || payload.mediaUrl) {
            await deliverMaxReply({
              payload: { ...payload, text: undefined },
              account,
              chatId: chatIdStr,
              replyToId: replyMid,
              callbackId,
              config,
              log,
              statusSink,
            });
          }
          return;
        }

        // Non-streaming path, no draft yet, or text too long for an edit —
        // chunked delivery handles the >DRAFT_MAX_CHARS case.
        draftStopped = true;
        await deliverMaxReply({
          payload,
          account,
          chatId: chatIdStr,
          replyToId: replyMid,
          callbackId,
          config,
          log,
          statusSink,
        });
      },
      onError: (err, info) => {
        log?.error(`[${account.accountId}] MAX ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
      ...(useEditStreaming
        ? {
            onPartialReply: (payload: { text?: string }) => {
              if (payload.text) draftUpdate(payload.text);
            },
          }
        : {}),
      // In partial (edit-streaming) mode disable block streaming so the block
      // dispatcher doesn't fight the draft editor over the same message.
      ...(useEditStreaming
        ? { disableBlockStreaming: true }
        : useBlockStreaming
          ? { disableBlockStreaming: false }
          : {}),
    },
  });

  // Cleanup draft stream
  await draftClear();
}

/** Toast shown the instant a callback button is pressed, before the (slow) agent
 *  reply. MAX keeps a loading spinner on the button until POST /answers is called;
 *  acking immediately clears it so the press registers even on the web client
 *  (which does not render the typing indicator). */
const MAX_CALLBACK_ACK_TOAST = '⏳ Думаю…';

async function processCallback(
  callback: MaxCallback,
  originalMessage: MaxMessage | undefined,
  opts: MaxMonitorOptions,
): Promise<void> {
  const payload = callback.payload ?? '';
  if (!payload.trim()) return;

  // Instant feedback: clear the button spinner right away. The agent's reply
  // arrives later as a normal message (delivery no longer goes through /answers,
  // so this single ack never double-answers the callback_id).
  void opts.api
    .answerCallback(callback.callback_id, { notification: MAX_CALLBACK_ACK_TOAST })
    .catch((err) =>
      opts.log?.debug?.(`[${opts.account.accountId}] callback ack failed: ${String(err)}`),
    );

  // Synthesize as a regular message. callback_id is not a valid MAX message id,
  // so replies to callback-originated commands must not use it as replyToMessageId.
  const syntheticMessage: MaxMessage & { __maxCallback?: boolean } = {
    __maxCallback: true,
    sender: callback.user,
    // Prefer the original message's recipient (real chat_id); fall back to the
    // legacy callback.message and finally the user_id. Sending to a user_id as a
    // chat_id 404s, so the real chat_id from update.message is essential in DMs.
    recipient: originalMessage?.recipient ??
      callback.message?.recipient ?? { chat_id: callback.user.user_id },
    timestamp: callback.timestamp,
    body: {
      mid: callback.callback_id,
      text: payload,
    },
  };

  await processIncomingMessage(syntheticMessage, null, opts);
}

async function processBotStarted(
  user: MaxUser,
  chatId: number | undefined,
  opts: MaxMonitorOptions,
): Promise<void> {
  // Synthesize a /start message
  const syntheticMessage: MaxMessage = {
    sender: user,
    recipient: { chat_id: chatId ?? user.user_id, chat_type: 'dialog' },
    timestamp: Date.now(),
    body: {
      mid: `bot_started_${user.user_id}_${Date.now()}`,
      text: '/start',
    },
  };

  await processIncomingMessage(syntheticMessage, null, opts);
}

// ── Deliver reply ──

async function deliverMaxReply(params: {
  payload: {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
    replyToId?: string;
    channelData?: unknown;
  };
  account: ResolvedMaxAccount;
  chatId: string;
  replyToId?: string;
  callbackId?: string;
  config: OpenClawConfig;
  log?: ChannelLogSink;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, account, chatId, config, log, statusSink } = params;
  const core = getMaxRuntime();
  const buttons = readMaxChannelButtons(payload.channelData);

  if (params.callbackId && (payload.text || buttons?.length)) {
    try {
      await answerMaxCallback(params.callbackId, payload.text ?? '', {
        token: account.token,
        format: 'markdown',
        buttons,
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    } catch (err: unknown) {
      const body = (err as { body?: unknown })?.body;
      log?.error(
        `[${account.accountId}] MAX callback answer failed: ${String(err)}${body ? ` body=${JSON.stringify(body)}` : ''}`,
      );
    }
    return;
  }

  if (payload.text) {
    const chunkLimit = 4000; // MAX message limit
    const chunkMode = core.channel.text.resolveChunkMode(config, 'max', account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(payload.text, chunkLimit, chunkMode);

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      try {
        await sendMaxMessage(chatId, chunk, {
          token: account.token,
          replyToMessageId: params.replyToId,
          format: 'markdown',
          buttons: index === chunks.length - 1 ? buttons : undefined,
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err: unknown) {
        const body = (err as { body?: unknown })?.body;
        log?.error(
          `[${account.accountId}] MAX send failed: ${String(err)}${body ? ` body=${JSON.stringify(body)}` : ''}`,
        );
      }
    }
  } else if (buttons?.length) {
    try {
      await sendMaxMessage(chatId, '', {
        token: account.token,
        replyToMessageId: params.replyToId,
        format: 'markdown',
        buttons,
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    } catch (err: unknown) {
      const body = (err as { body?: unknown })?.body;
      log?.error(
        `[${account.accountId}] MAX send failed: ${String(err)}${body ? ` body=${JSON.stringify(body)}` : ''}`,
      );
    }
  }

  // Media URLs — upload and send
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  for (const mediaUrl of mediaList) {
    try {
      // Download media first if it's a URL
      if (mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://')) {
        const maxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
        const loaded = await core.channel.media.readRemoteMediaBuffer({ url: mediaUrl, maxBytes });

        // Write to temp file
        const fs = await import('fs/promises');
        const tmpPath = `/tmp/max-media-${Date.now()}-${loaded.fileName ?? 'file'}`;
        await fs.writeFile(tmpPath, loaded.buffer);

        try {
          await sendMaxMediaMessage(chatId, '', tmpPath, {
            token: account.token,
            replyToMessageId: params.replyToId,
          });
          statusSink?.({ lastOutboundAt: Date.now() });
        } finally {
          // Cleanup temp file
          await fs.unlink(tmpPath).catch(() => {});
        }
      } else {
        // Local file path
        await sendMaxMediaMessage(chatId, '', mediaUrl, {
          token: account.token,
          replyToMessageId: params.replyToId,
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      }
    } catch (err) {
      log?.error(`[${account.accountId}] MAX media send failed: ${String(err)}`);
    }
  }
}

// ── Chat registry helpers ──

/**
 * Record a group/channel chat seen on an inbound message. Fire-and-forget so it
 * never delays the reply pipeline; dialogs (DMs) are ignored. Called before the
 * bot-self skip so a chat the bot only posts to is still discovered.
 * @internal - Exported for testing only.
 */
export function recordInboundChat(message: MaxMessage, opts: MaxMonitorOptions): void {
  const chatId = message.recipient?.chat_id;
  const chatType = message.recipient?.chat_type;
  if (chatId == null) return;
  if (chatType !== 'chat' && chatType !== 'channel') {
    if (chatType && chatType !== 'dialog') {
      // Unknown non-dialog chat type — surface it rather than silently dropping.
      opts.log?.debug?.(
        `[${opts.account.accountId}] Unhandled chat_type for registry: ${chatType}`,
      );
    }
    return;
  }
  upsertChat(opts.account.accountId, {
    chatId,
    kind: chatType === 'channel' ? 'channel' : 'group',
    seenAt: message.timestamp || Date.now(),
  });
  void maybeFetchChatMeta(chatId, opts);
}

/**
 * Lazily fetch chat title + type via getChat (non-deprecated) at most once per
 * chat per session. Marks the attempt up front (sync, before the await) so a
 * burst of messages fires only one request. Best-effort — never throws.
 */
async function maybeFetchChatMeta(chatId: number, opts: MaxMonitorOptions): Promise<void> {
  const { account, api, log } = opts;
  if (!needsTitle(account.accountId, chatId)) return;
  markTitleFetched(account.accountId, chatId);
  try {
    const chat = await api.getChat(chatId);
    const meta: { title?: string; kind?: 'group' | 'channel' } = {};
    if (chat?.title) meta.title = chat.title;
    if (chat?.type === 'channel' || chat?.type === 'chat') {
      meta.kind = chat.type === 'channel' ? 'channel' : 'group';
    }
    if (meta.title != null || meta.kind != null) setChatMeta(account.accountId, chatId, meta);
  } catch (err) {
    log?.debug?.(`[${account.accountId}] getChat(${chatId}) for meta failed: ${String(err)}`);
  }
}

/** Seed the registry with numeric chat ids already present in the account config. */
function seedChatsFromConfig(account: ResolvedMaxAccount): void {
  const groups = account.config.groups ?? {};
  const now = Date.now();
  for (const key of Object.keys(groups)) {
    if (key === '*') continue;
    const chatId = Number(key);
    if (!Number.isFinite(chatId)) continue;
    // kind:'group' is a placeholder; config carries no chat type. The first
    // real update (bot_added.is_channel / message.recipient.chat_type) or the
    // lazy getChat corrects it to 'channel' where applicable.
    upsertChat(account.accountId, { chatId, kind: 'group', seenAt: now });
  }
}

// ── Helpers ──

function formatSenderName(user?: MaxUser | null): string {
  if (!user) return 'Unknown';
  const parts = [user.first_name];
  if (user.last_name) parts.push(user.last_name);
  return parts.join(' ') || user.username || `user_${user.user_id}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
