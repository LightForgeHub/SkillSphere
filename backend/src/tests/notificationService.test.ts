import {
  NotificationService,
  formatArbitrationEmbed,
  formatBookingEmbed,
  formatRateLabel,
  getNotificationService,
  setNotificationService,
  truncateAddress,
} from "../notificationService";

type FetchCall = {
  url: string;
  init?: RequestInit;
};

function mockFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = (async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown = { ok: true }): Response {
  if (status === 204 || status === 205) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("notification format helpers", () => {
  it("truncates long addresses", () => {
    expect(truncateAddress("GABCDEFGHIJKLMNOP")).toBe("GABC…MNOP");
    expect(truncateAddress("short")).toBe("short");
    expect(truncateAddress("")).toBe("unknown");
  });

  it("formats hourly rate and escrow fallbacks", () => {
    expect(formatRateLabel(50)).toBe("$50/hr");
    expect(formatRateLabel(12.5)).toBe("$12.5/hr");
    expect(formatRateLabel(undefined, 50_000_000n)).toBe("5 XLM escrow");
    expect(formatRateLabel()).toBe("rate TBD");
  });

  it("builds a booking embed matching the product copy", () => {
    const embed = formatBookingEmbed({
      seekerAddress: "GSEEKERADDRESSLONGVALUEHERE",
      sessionId: "sess_1",
      hourlyRate: 50,
      expertAddress: "GEXPERT",
    });

    expect(embed.title).toBe("New session booking");
    expect(embed.description).toMatch(/New booking request from Seeker/);
    expect(embed.description).toContain("$50/hr");
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Seeker", value: "GSEEKERADDRESSLONGVALUEHERE" }),
        expect.objectContaining({ name: "Session", value: "sess_1" }),
        expect.objectContaining({ name: "Rate", value: "$50/hr" }),
      ])
    );
  });

  it("builds an arbitration embed", () => {
    const embed = formatArbitrationEmbed({
      seekerAddress: "GSEEKER",
      sessionId: "sess_arb",
      reason: "No-show",
      requestId: "arb_1",
    });

    expect(embed.title).toBe("Arbitration request");
    expect(embed.description).toMatch(/New arbitration request from Seeker/);
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Reason", value: "No-show" }),
        expect.objectContaining({ name: "Request ID", value: "arb_1" }),
      ])
    );
  });
});

describe("NotificationService", () => {
  afterEach(() => {
    setNotificationService(null);
  });

  it("posts formatted Discord embeds and Telegram HTML messages", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(204));

    const service = new NotificationService({
      discordWebhookUrl: "https://discord.example/webhook",
      telegramWebhookUrl: "https://api.telegram.org/botTOKEN/sendMessage",
      telegramChatId: "12345",
      fetchImpl,
    });

    const result = await service.notifyBooking({
      seekerAddress: "GSEEKERADDRESSLONGVALUEHERE",
      sessionId: "sess_book_1",
      hourlyRate: 50,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);

    const discord = calls.find((c) => c.url.includes("discord"));
    const telegram = calls.find((c) => c.url.includes("telegram"));
    expect(discord).toBeDefined();
    expect(telegram).toBeDefined();

    const discordBody = JSON.parse(String(discord!.init?.body));
    expect(discordBody.embeds[0].title).toBe("New session booking");
    expect(discordBody.embeds[0].description).toContain("$50/hr");
    expect(discordBody.embeds[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Session", value: "sess_book_1" }),
      ])
    );

    const telegramBody = JSON.parse(String(telegram!.init?.body));
    expect(telegramBody.chat_id).toBe("12345");
    expect(telegramBody.parse_mode).toBe("HTML");
    expect(telegramBody.text).toContain("<b>New session booking</b>");
    expect(telegramBody.text).toContain("$50/hr");
  });

  it("reads chat_id from the Telegram webhook URL query string", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(200));

    const service = new NotificationService({
      telegramWebhookUrl:
        "https://api.telegram.org/botTOKEN/sendMessage?chat_id=999",
      fetchImpl,
    });

    const result = await service.notifyArbitration({
      seekerAddress: "GSEEKER",
      sessionId: "sess_x",
      reason: "Quality dispute",
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.chat_id).toBe("999");
    expect(body.text).toContain("Arbitration request");
    expect(calls[0].url).not.toContain("chat_id=");
  });

  it("returns ok when no webhooks are configured", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(200));
    const service = new NotificationService({ fetchImpl });

    const result = await service.notifyBooking({
      seekerAddress: "GSEEKER",
      sessionId: "sess_noop",
    });

    expect(result.ok).toBe(true);
    expect(result.results.every((r) => r.skipped)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("does not throw when Discord returns an HTTP error", async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse(500, { message: "boom" }));
    const service = new NotificationService({
      discordWebhookUrl: "https://discord.example/webhook",
      fetchImpl,
    });

    const result = await service.notifyBooking({
      seekerAddress: "GSEEKER",
      sessionId: "sess_fail",
    });

    expect(result.ok).toBe(false);
    expect(result.results.find((r) => r.channel === "discord")?.ok).toBe(false);
  });

  it("does not throw on network failures or timeouts", async () => {
    const { fetchImpl } = mockFetch(async () => {
      const err = new Error("timeout after 1ms");
      err.name = "AbortError";
      throw err;
    });

    const service = new NotificationService({
      discordWebhookUrl: "https://discord.example/webhook",
      timeoutMs: 1,
      fetchImpl,
    });

    await expect(
      service.notifyBooking({
        seekerAddress: "GSEEKER",
        sessionId: "sess_timeout",
      })
    ).resolves.toMatchObject({ ok: false });
  });

  it("reports missing Telegram chat_id without throwing", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(200));
    const service = new NotificationService({
      telegramWebhookUrl: "https://api.telegram.org/botTOKEN/sendMessage",
      fetchImpl,
    });

    const result = await service.notifyBooking({
      seekerAddress: "GSEEKER",
      sessionId: "sess_no_chat",
    });

    expect(result.ok).toBe(false);
    expect(result.results.find((r) => r.channel === "telegram")?.error).toMatch(
      /chat_id/i
    );
    expect(calls).toHaveLength(0);
  });

  it("fromEnv reads webhook configuration", async () => {
    const prevDiscord = process.env.DISCORD_WEBHOOK_URL;
    const prevTelegram = process.env.TELEGRAM_WEBHOOK_URL;
    const prevChat = process.env.TELEGRAM_CHAT_ID;

    process.env.DISCORD_WEBHOOK_URL = "https://discord.example/from-env";
    process.env.TELEGRAM_WEBHOOK_URL =
      "https://api.telegram.org/botENV/sendMessage";
    process.env.TELEGRAM_CHAT_ID = "env-chat";

    try {
      const { fetchImpl, calls } = mockFetch(() => jsonResponse(204));
      const service = NotificationService.fromEnv({ fetchImpl });
      expect(service.isConfigured).toBe(true);

      await service.notifyBooking({
        seekerAddress: "GSEEKER",
        sessionId: "sess_env",
        hourlyRate: 10,
      });

      expect(calls.map((c) => c.url)).toEqual(
        expect.arrayContaining([
          "https://discord.example/from-env",
          "https://api.telegram.org/botENV/sendMessage",
        ])
      );
    } finally {
      if (prevDiscord === undefined) delete process.env.DISCORD_WEBHOOK_URL;
      else process.env.DISCORD_WEBHOOK_URL = prevDiscord;
      if (prevTelegram === undefined) delete process.env.TELEGRAM_WEBHOOK_URL;
      else process.env.TELEGRAM_WEBHOOK_URL = prevTelegram;
      if (prevChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
      else process.env.TELEGRAM_CHAT_ID = prevChat;
    }
  });

  it("notifyBookingAsync never rejects to the caller", async () => {
    const errors: unknown[] = [];
    const { fetchImpl } = mockFetch(() => {
      throw new Error("network down");
    });

    const service = new NotificationService({
      discordWebhookUrl: "https://discord.example/webhook",
      fetchImpl,
      logger: {
        error: (...args: unknown[]) => {
          errors.push(args);
        },
        warn: () => undefined,
        info: () => undefined,
      },
    });

    expect(() =>
      service.notifyBookingAsync({
        seekerAddress: "GSEEKER",
        sessionId: "sess_async",
      })
    ).not.toThrow();

    // Flush microtasks so the logged failure is observed.
    await new Promise((r) => setImmediate(r));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("notifyArbitrationAsync logs failures without throwing", async () => {
    const errors: unknown[] = [];
    const { fetchImpl } = mockFetch(() => {
      throw new Error("telegram down");
    });

    const service = new NotificationService({
      telegramWebhookUrl: "https://api.telegram.org/botT/sendMessage",
      telegramChatId: "1",
      fetchImpl,
      logger: {
        error: (...args: unknown[]) => {
          errors.push(args);
        },
        warn: () => undefined,
        info: () => undefined,
      },
    });

    expect(() =>
      service.notifyArbitrationAsync({
        seekerAddress: "GSEEKER",
        sessionId: "sess_arb_async",
        reason: "timeout",
      })
    ).not.toThrow();

    await new Promise((r) => setImmediate(r));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("includes expert name on booking embeds when provided", () => {
    const embed = formatBookingEmbed({
      seekerAddress: "GSEEKER",
      sessionId: "sess_named",
      hourlyRate: 20,
      expertName: "Ada",
    });
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Expert name", value: "Ada" }),
      ])
    );
  });

  it("exposes a default service via getNotificationService", () => {
    setNotificationService(null);
    const service = getNotificationService();
    expect(service).toBeInstanceOf(NotificationService);
    expect(getNotificationService()).toBe(service);
  });
});
