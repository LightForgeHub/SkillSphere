/**
 * Outbound expert notifier for Discord / Telegram webhooks.
 * Failures and timeouts are swallowed so callers never block the core request path.
 */

export type NotificationKind = "BOOKING" | "ARBITRATION";

export interface BookingNotificationContext {
  seekerAddress: string;
  expertAddress?: string;
  sessionId: string;
  hourlyRate?: number;
  escrowAmount?: bigint | string | number;
  expertName?: string;
}

export interface ArbitrationNotificationContext {
  seekerAddress: string;
  expertAddress?: string;
  sessionId?: string;
  reason?: string;
  requestId?: string;
}

export interface NotificationServiceOptions {
  discordWebhookUrl?: string;
  telegramWebhookUrl?: string;
  telegramChatId?: string;
  /** HTTP timeout for third-party APIs (default 5s). */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "error" | "warn" | "info">;
}

export interface NotifyChannelResult {
  channel: "discord" | "telegram";
  ok: boolean;
  status?: number;
  error?: string;
  skipped?: boolean;
}

export interface NotifyResult {
  /** True when every *configured* channel succeeded (or nothing was configured). */
  ok: boolean;
  results: NotifyChannelResult[];
}

interface FormattedEmbed {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DISCORD_BOOKING_COLOR = 0x0d9488;
const DISCORD_ARBITRATION_COLOR = 0xdc2626;

let defaultService: NotificationService | null = null;

/**
 * Shorten a Stellar address for readable embeds while keeping prefix/suffix.
 */
export function truncateAddress(address: string, head = 4, tail = 4): string {
  if (!address) return "unknown";
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/**
 * Prefer expert hourly rate ($N/hr); fall back to escrow stroops as XLM.
 */
export function formatRateLabel(
  hourlyRate?: number,
  escrowAmount?: bigint | string | number
): string {
  if (typeof hourlyRate === "number" && Number.isFinite(hourlyRate) && hourlyRate > 0) {
    const rounded =
      Number.isInteger(hourlyRate) || Math.abs(hourlyRate) >= 100
        ? hourlyRate.toFixed(0)
        : hourlyRate.toFixed(2).replace(/\.?0+$/, "");
    return `$${rounded}/hr`;
  }

  if (escrowAmount !== undefined && escrowAmount !== null && escrowAmount !== "") {
    try {
      const stroops = BigInt(String(escrowAmount));
      const xlm = Number(stroops) / 10_000_000;
      if (Number.isFinite(xlm)) {
        const label =
          xlm >= 1 ? xlm.toFixed(2).replace(/\.?0+$/, "") : xlm.toFixed(7).replace(/\.?0+$/, "");
        return `${label} XLM escrow`;
      }
    } catch {
      // ignore invalid amounts
    }
  }

  return "rate TBD";
}

export function formatBookingEmbed(ctx: BookingNotificationContext): FormattedEmbed {
  const seeker = truncateAddress(ctx.seekerAddress);
  const rate = formatRateLabel(ctx.hourlyRate, ctx.escrowAmount);
  const description = `New booking request from Seeker \`${seeker}\` for ${rate}`;

  const fields: FormattedEmbed["fields"] = [
    { name: "Seeker", value: ctx.seekerAddress, inline: false },
    { name: "Session", value: ctx.sessionId, inline: true },
    { name: "Rate", value: rate, inline: true },
  ];

  if (ctx.expertAddress) {
    fields.push({ name: "Expert", value: ctx.expertAddress, inline: false });
  }
  if (ctx.expertName) {
    fields.push({ name: "Expert name", value: ctx.expertName, inline: true });
  }

  return {
    title: "New session booking",
    description,
    color: DISCORD_BOOKING_COLOR,
    fields,
  };
}

export function formatArbitrationEmbed(
  ctx: ArbitrationNotificationContext
): FormattedEmbed {
  const seeker = truncateAddress(ctx.seekerAddress);
  const description = `New arbitration request from Seeker \`${seeker}\``;

  const fields: FormattedEmbed["fields"] = [
    { name: "Seeker", value: ctx.seekerAddress, inline: false },
  ];

  if (ctx.sessionId) {
    fields.push({ name: "Session", value: ctx.sessionId, inline: true });
  }
  if (ctx.requestId) {
    fields.push({ name: "Request ID", value: ctx.requestId, inline: true });
  }
  if (ctx.expertAddress) {
    fields.push({ name: "Expert", value: ctx.expertAddress, inline: false });
  }
  if (ctx.reason) {
    fields.push({ name: "Reason", value: ctx.reason, inline: false });
  }

  return {
    title: "Arbitration request",
    description,
    color: DISCORD_ARBITRATION_COLOR,
    fields,
  };
}

function embedToTelegramHtml(embed: FormattedEmbed): string {
  const lines = [
    `<b>${escapeHtml(embed.title)}</b>`,
    escapeHtml(embed.description.replace(/`/g, "")),
    "",
  ];

  for (const field of embed.fields) {
    lines.push(`<b>${escapeHtml(field.name)}:</b> <code>${escapeHtml(field.value)}</code>`);
  }

  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resolveTelegramChatId(
  webhookUrl: string,
  explicitChatId?: string
): string | undefined {
  if (explicitChatId) return explicitChatId;
  try {
    const url = new URL(webhookUrl);
    return url.searchParams.get("chat_id") ?? undefined;
  } catch {
    return undefined;
  }
}

export class NotificationService {
  private readonly discordWebhookUrl?: string;
  private readonly telegramWebhookUrl?: string;
  private readonly telegramChatId?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Pick<Console, "error" | "warn" | "info">;

  constructor(options: NotificationServiceOptions = {}) {
    this.discordWebhookUrl = options.discordWebhookUrl?.trim() || undefined;
    this.telegramWebhookUrl = options.telegramWebhookUrl?.trim() || undefined;
    this.telegramChatId = options.telegramChatId?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? console;
  }

  static fromEnv(
    overrides: NotificationServiceOptions = {}
  ): NotificationService {
    return new NotificationService({
      discordWebhookUrl:
        overrides.discordWebhookUrl ?? process.env.DISCORD_WEBHOOK_URL,
      telegramWebhookUrl:
        overrides.telegramWebhookUrl ?? process.env.TELEGRAM_WEBHOOK_URL,
      telegramChatId:
        overrides.telegramChatId ?? process.env.TELEGRAM_CHAT_ID,
      timeoutMs: overrides.timeoutMs,
      fetchImpl: overrides.fetchImpl,
      logger: overrides.logger,
    });
  }

  get isConfigured(): boolean {
    return Boolean(this.discordWebhookUrl || this.telegramWebhookUrl);
  }

  /**
   * Notify experts of a newly booked session.
   * Never throws — network failures are returned in {@link NotifyResult}.
   */
  async notifyBooking(ctx: BookingNotificationContext): Promise<NotifyResult> {
    return this.dispatch(formatBookingEmbed(ctx));
  }

  /**
   * Notify experts of a new arbitration / dispute request.
   * Never throws — network failures are returned in {@link NotifyResult}.
   */
  async notifyArbitration(
    ctx: ArbitrationNotificationContext
  ): Promise<NotifyResult> {
    return this.dispatch(formatArbitrationEmbed(ctx));
  }

  /**
   * Fire-and-forget booking notification. Safe to call from hot paths —
   * errors are logged and never propagated to the caller.
   */
  notifyBookingAsync(ctx: BookingNotificationContext): void {
    void this.notifyBooking(ctx).then((result) => {
      if (!result.ok) {
        this.logger.error(
          "[NotificationService] booking notification failed:",
          summarizeFailures(result)
        );
      }
    });
  }

  /**
   * Fire-and-forget arbitration notification.
   */
  notifyArbitrationAsync(ctx: ArbitrationNotificationContext): void {
    void this.notifyArbitration(ctx).then((result) => {
      if (!result.ok) {
        this.logger.error(
          "[NotificationService] arbitration notification failed:",
          summarizeFailures(result)
        );
      }
    });
  }

  private async dispatch(embed: FormattedEmbed): Promise<NotifyResult> {
    const tasks: Array<Promise<NotifyChannelResult>> = [];

    if (this.discordWebhookUrl) {
      tasks.push(this.postDiscord(this.discordWebhookUrl, embed));
    } else {
      tasks.push(
        Promise.resolve({
          channel: "discord" as const,
          ok: true,
          skipped: true,
        })
      );
    }

    if (this.telegramWebhookUrl) {
      tasks.push(this.postTelegram(this.telegramWebhookUrl, embed));
    } else {
      tasks.push(
        Promise.resolve({
          channel: "telegram" as const,
          ok: true,
          skipped: true,
        })
      );
    }

    const results = await Promise.all(tasks);
    const configured = results.filter((r) => !r.skipped);
    const ok =
      configured.length === 0 || configured.every((r) => r.ok);

    return { ok, results };
  }

  private async postDiscord(
    url: string,
    embed: FormattedEmbed
  ): Promise<NotifyChannelResult> {
    return this.postJson(
      "discord",
      url,
      {
        content: null,
        embeds: [
          {
            title: embed.title,
            description: embed.description,
            color: embed.color,
            fields: embed.fields,
            timestamp: new Date().toISOString(),
          },
        ],
      }
    );
  }

  private async postTelegram(
    url: string,
    embed: FormattedEmbed
  ): Promise<NotifyChannelResult> {
    const chatId = resolveTelegramChatId(url, this.telegramChatId);
    if (!chatId) {
      return {
        channel: "telegram",
        ok: false,
        error:
          "Telegram chat_id missing — set TELEGRAM_CHAT_ID or ?chat_id= on the webhook URL",
      };
    }

    // Strip chat_id from query when present so the Bot API path stays clean.
    let endpoint = url;
    try {
      const parsed = new URL(url);
      parsed.searchParams.delete("chat_id");
      endpoint = parsed.toString();
    } catch {
      endpoint = url;
    }

    return this.postJson("telegram", endpoint, {
      chat_id: chatId,
      text: embedToTelegramHtml(embed),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }

  private async postJson(
    channel: "discord" | "telegram",
    url: string,
    body: unknown
  ): Promise<NotifyChannelResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        let detail = "";
        try {
          detail = (await response.text()).slice(0, 200);
        } catch {
          // ignore body read errors
        }
        return {
          channel,
          ok: false,
          status: response.status,
          error: detail || `HTTP ${response.status}`,
        };
      }

      return { channel, ok: true, status: response.status };
    } catch (err) {
      const message =
        err instanceof Error
          ? err.name === "AbortError"
            ? `timeout after ${this.timeoutMs}ms`
            : err.message
          : String(err);

      return { channel, ok: false, error: message };
    } finally {
      clearTimeout(timer);
    }
  }
}

function summarizeFailures(result: NotifyResult): string {
  return result.results
    .filter((r) => !r.skipped && !r.ok)
    .map((r) => `${r.channel}: ${r.error ?? r.status ?? "failed"}`)
    .join("; ");
}

/** Process-wide notifier used by event handlers (overridable in tests). */
export function getNotificationService(): NotificationService {
  if (!defaultService) {
    defaultService = NotificationService.fromEnv();
  }
  return defaultService;
}

export function setNotificationService(
  service: NotificationService | null
): void {
  defaultService = service;
}
