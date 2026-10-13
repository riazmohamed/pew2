/**
 * Every live voice conversation this daemon is running.
 *
 * `voice.start` lands here from the shared handler: create the session with
 * OpenAI from the phone's SDP offer, answer, then attach the sideband that runs
 * the tools. Capped, clocked and closed with the daemon.
 */
import { basename } from "node:path";
import type { wire } from "@pew2/protocol";
import type { VoiceHost, VoiceObservation } from "./host.js";
import { NO_KEY_REASON, readVoiceConfig, type VoiceConfig } from "./config.js";
import { attachUrl, authHeaders, createLiveSession, type FetchLike } from "./openai.js";
import { BACKEND_INSTRUCTIONS, LIVE_INSTRUCTIONS, TOOLS, speakable, tail } from "./prompts.js";
import { defaultCreateSocket, LiveVoiceSession, type CreateSocket, type Target } from "./session.js";

/** Live voice sessions at once. A phone redialling replaces the oldest. */
export const MAX_LIVE_VOICE = 2;

export type VoiceAvailability = { available: boolean; reason?: string };

export class VoiceManager {
  private readonly live = new Map<string, LiveVoiceSession>();
  private availability: VoiceAvailability = { available: false, reason: NO_KEY_REASON };

  constructor(
    private readonly host: VoiceHost,
    private readonly io: { fetch?: FetchLike; createSocket?: CreateSocket } = {},
  ) {}

  /** For the provider announcement. Kept fresh by `refresh()`. */
  get status(): VoiceAvailability {
    return this.availability;
  }

  /** Re-read the key, so `pew2 voice key` takes effect on the next connect. */
  async refresh(): Promise<VoiceAvailability> {
    const config = await readVoiceConfig(this.host.env);
    this.availability = config.apiKey ? { available: true } : { available: false, reason: NO_KEY_REASON };
    return this.availability;
  }

  sessions(): LiveVoiceSession[] {
    return [...this.live.values()];
  }

  async start(message: wire.VoiceStart): Promise<wire.VoiceAnswer> {
    const config = await readVoiceConfig(this.host.env);
    const answer = (fields: Partial<wire.VoiceAnswer>): wire.VoiceAnswer => ({
      t: "voice.answer",
      requestId: message.requestId,
      ...fields,
    });
    if (!config.apiKey) {
      return answer({ error: "No OpenAI API key on your computer yet. Run pew2 voice key there to add one." });
    }

    const target = await this.initialTarget(message);
    const created = await createLiveSession({
      apiKey: config.apiKey,
      sdp: message.sdp,
      session: this.sessionConfig(config, target),
      fetch: this.io.fetch,
    });
    if (!created.ok) return answer({ error: created.error });

    while (this.live.size >= MAX_LIVE_VOICE) {
      const oldest = this.live.values().next().value;
      if (!oldest) break;
      this.live.delete(oldest.liveSessionId);
      void oldest.close();
    }

    const session = new LiveVoiceSession(created.liveSessionId, this.host, target, {
      maxMs: config.maxMinutes * 60_000,
      onFinished: (s) => {
        if (this.live.get(s.liveSessionId) === s) this.live.delete(s.liveSessionId);
      },
    });
    this.live.set(created.liveSessionId, session);
    session.attach(
      this.io.createSocket ?? defaultCreateSocket,
      attachUrl(created.liveSessionId),
      authHeaders(config.apiKey),
    );
    return answer({
      liveSessionId: created.liveSessionId,
      sdp: created.sdp,
      voiceRatePerMinuteUsd: config.voiceRatePerMinuteUsd,
    });
  }

  async stop(liveSessionId: string): Promise<void> {
    await this.live.get(liveSessionId)?.close();
  }

  observe(observation: VoiceObservation) {
    for (const session of this.live.values()) session.observe(observation);
  }

  closeAll() {
    for (const session of [...this.live.values()]) void session.close();
  }

  /** Where coding work goes until the user says otherwise. */
  private async initialTarget(message: wire.VoiceStart): Promise<Target> {
    const view = message.sessionId ? this.host.session(message.sessionId) : undefined;
    if (view) {
      return {
        sessionId: view.sessionId,
        providerId: view.providerId,
        cwd: view.cwd,
        agentSessionId: view.agentSessionId,
      };
    }
    const agents = this.host.agents().filter((a) => a.available);
    const providerId =
      message.providerId && agents.some((a) => a.id === message.providerId)
        ? message.providerId
        : agents[0]?.id;
    if (!providerId) return {};
    // A client-named path only through `knownProject()`, like everywhere else.
    const cwd =
      (message.cwd ? await this.host.knownProject(providerId, message.cwd) : undefined) ??
      (await this.host.lastWorkspace(providerId));
    return { providerId, cwd };
  }

  sessionConfig(config: VoiceConfig, target: Target): Record<string, unknown> {
    return {
      model: "gpt-live-1",
      instructions: LIVE_INSTRUCTIONS,
      audio: { output: { voice: config.voice } },
      ...(this.seed(target) && { input: this.seed(target) }),
      delegation: {
        type: "responses",
        responses: {
          model: config.backendModel,
          instructions: BACKEND_INSTRUCTIONS,
          tools: TOOLS,
          tool_choice: "auto",
          parallel_tool_calls: false,
          reasoning: { effort: "low" },
        },
      },
    };
  }

  /** A short note of what is on screen, so "how's it going?" has an answer. */
  private seed(target: Target): unknown[] | undefined {
    if (!target.providerId) return undefined;
    const agent = this.host.agents().find((a) => a.id === target.providerId)?.name ?? target.providerId;
    const lines = [
      `Context from the pew2 app, not said aloud: the current coding conversation is with ${agent}${target.cwd ? ` in the project ${basename(target.cwd)}` : ""}.`,
    ];
    const exchange = target.sessionId ? this.host.lastExchange(target.sessionId) : undefined;
    if (exchange?.request) lines.push(`The user's last request to it: ${tail(speakable(exchange.request), 600)}`);
    if (exchange?.reply) lines.push(`Its last reply ends: ${tail(speakable(exchange.reply), 1000)}`);
    return [
      { type: "message", role: "user", content: [{ type: "input_text", text: lines.join("\n") }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Understood." }] },
    ];
  }
}
