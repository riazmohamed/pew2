/**
 * Slash commands and selectors for `pew2 chat`: which commands are pew2's own,
 * which are the agent's, how a typed `/name` is routed, how Tab completes it,
 * and how `/model`, `/thinking` and `/mode` read and pick the session's config
 * options. Pure, so it is tested without a socket.
 */

export interface CommandInfo {
  name: string;
  description: string;
  hint?: string;
}

/** pew2's own commands. These win over an agent command of the same name. */
export const LOCAL_COMMANDS: readonly CommandInfo[] = [
  { name: "help", description: "list commands" },
  { name: "model", description: "list or switch the model", hint: "[n|name]" },
  { name: "thinking", description: "list or switch the thinking level", hint: "[n|name]" },
  { name: "mode", description: "list or switch the agent's mode", hint: "[n|name]" },
  {
    name: "shot",
    description: "send a screenshot of this Mac (area: drag a region)",
    hint: "[area] [message]",
  },
  {
    name: "attach",
    description: "send an image file (drop it on the window)",
    hint: "<path> [message]",
  },
  { name: "sessions", description: "list open conversations" },
  { name: "switch", description: "follow one of them", hint: "<n>" },
  { name: "new", description: "start a new conversation" },
  { name: "cancel", description: "stop the current turn" },
  { name: "awake", description: "keep this Mac awake while in use", hint: "on|off" },
  { name: "quit", description: "leave (Esc or Ctrl-C too)" },
  { name: "exit", description: "leave" },
];

const LOCAL_NAMES = new Set(LOCAL_COMMANDS.map((c) => c.name));

function normalise(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

/** The agent's commands out of a session event, or undefined for any other event. */
export function readAgentCommands(payload: unknown): CommandInfo[] | undefined {
  const update = (
    payload as { update?: { sessionUpdate?: unknown; availableCommands?: unknown } } | null
  )?.update;
  if (update?.sessionUpdate !== "available_commands_update") return undefined;
  return agentCommandList(update.availableCommands);
}

/** Normalise a raw command list (from an event or `provider.capabilities`). */
export function agentCommandList(raw: unknown): CommandInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: CommandInfo[] = [];
  for (const entry of raw as {
    name?: unknown;
    description?: unknown;
    hint?: unknown;
    input?: { hint?: unknown };
  }[]) {
    if (typeof entry?.name !== "string" || !entry.name.trim()) continue;
    const hint =
      typeof entry.hint === "string"
        ? entry.hint
        : typeof entry.input?.hint === "string"
          ? entry.input.hint
          : undefined;
    out.push({
      name: normalise(entry.name),
      description: typeof entry.description === "string" ? entry.description : "",
      ...(hint ? { hint } : {}),
    });
  }
  return out;
}

export type SlashRoute =
  | { kind: "local"; name: string; arg: string }
  | { kind: "agent"; name: string; text: string }
  | { kind: "unknown"; name: string };

/**
 * Where a typed `/name args` goes. pew2's own command first; then the agent's,
 * which is sent as an ordinary prompt because that is how ACP slash commands
 * travel; otherwise unknown.
 */
export function routeSlash(text: string, agent: readonly CommandInfo[]): SlashRoute {
  const trimmed = text.trim();
  const match = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  const name = normalise(match?.[1] ?? trimmed.slice(1).split(/\s+/)[0] ?? "");
  const arg = (match?.[2] ?? "").trim();
  if (LOCAL_NAMES.has(name)) return { kind: "local", name, arg };
  if (agent.some((c) => c.name === name)) return { kind: "agent", name, text: trimmed };
  return { kind: "unknown", name };
}

/** pew2's commands, then the agent's, with clashes marked. For `/help`. */
export function helpLines(agent: readonly CommandInfo[], agentName: string): string[] {
  const pad = (c: CommandInfo) => `/${c.name}${c.hint ? ` ${c.hint}` : ""}`.padEnd(26);
  const lines = ["pew2 commands:"];
  for (const c of LOCAL_COMMANDS) if (c.name !== "exit") lines.push(`  ${pad(c)} ${c.description}`);
  lines.push("  A number on its own answers a permission request. Tab completes a command.");
  if (agent.length === 0) {
    lines.push(`${agentName} has not listed any commands of its own yet.`);
    return lines;
  }
  lines.push(`${agentName} commands (sent to the agent as a prompt):`);
  const clashes: string[] = [];
  for (const c of [...agent].sort((a, b) => a.name.localeCompare(b.name))) {
    if (LOCAL_NAMES.has(c.name)) {
      clashes.push(c.name);
      continue;
    }
    lines.push(`  ${pad(c)} ${c.description}`);
  }
  if (clashes.length > 0) {
    lines.push(
      `  Also offered by ${agentName} but pew2's own wins here: ${clashes.map((n) => `/${n}`).join(", ")}`,
    );
  }
  return lines;
}

export interface Completion {
  /** The new input. Unchanged when nothing matched. */
  input: string;
  /** Every candidate, when more than one remains. */
  candidates: string[];
}

/** Tab on a `/name` being typed: finish it, or extend to the common prefix. */
export function completeSlash(input: string, names: readonly string[]): Completion {
  const match = /^\/([\w:.-]*)$/.exec(input);
  if (!match) return { input, candidates: [] };
  const typed = match[1]!.toLowerCase();
  const all = [...new Set(names)].sort();
  const hits = all.filter((n) => n.startsWith(typed));
  if (hits.length === 0) return { input, candidates: [] };
  if (hits.length === 1) return { input: `/${hits[0]} `, candidates: [] };
  let common = hits[0]!;
  for (const hit of hits) while (!hit.startsWith(common)) common = common.slice(0, -1);
  return { input: `/${common.length > typed.length ? common : typed}`, candidates: hits };
}

/** Commands matching a half-typed `/name`, local first, for the menu under the input. */
export function slashMatches(
  input: string,
  agent: readonly CommandInfo[],
): { name: string; description: string; agent?: boolean }[] {
  const match = /^\/([\w:.-]*)$/.exec(input);
  if (!match) return [];
  const typed = match[1]!.toLowerCase();
  const local = LOCAL_COMMANDS.filter((c) => c.name !== "exit" && c.name.startsWith(typed));
  const theirs = agent
    .filter((c) => !LOCAL_NAMES.has(c.name) && c.name.startsWith(typed))
    .map((c) => ({ ...c, agent: true }));
  return [...local, ...theirs];
}

/** A selector as the daemon sends it (`ConfigOption` in the wire schema). */
export interface ConfigOptionLike {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue: string | boolean;
  options?: { value: string; name: string; description?: string }[];
}

export type ConfigCategory = "model" | "thought_level" | "mode";

export const CATEGORY_FOR_COMMAND: Record<string, ConfigCategory> = {
  model: "model",
  thinking: "thought_level",
  mode: "mode",
};

const CATEGORY_LABEL: Record<ConfigCategory, string> = {
  model: "model",
  thought_level: "thinking level",
  mode: "mode",
};

/** The selector for a category. Falls back to a matching id for agents that skip `category`. */
export function findOption(
  options: readonly ConfigOptionLike[],
  category: ConfigCategory,
): ConfigOptionLike | undefined {
  return (
    options.find((o) => o.category === category) ??
    options.find(
      (o) =>
        o.id === category ||
        (category === "thought_level" && /^(thinking|thought|effort|reasoning)/i.test(o.id)),
    )
  );
}

/** The display name of the current value, for the footer. */
export function currentLabel(option: ConfigOptionLike | undefined): string | undefined {
  if (!option) return undefined;
  if (typeof option.currentValue === "boolean") return option.currentValue ? "on" : "off";
  return option.options?.find((o) => o.value === option.currentValue)?.name ?? option.currentValue;
}

/** Numbered choices with the current one marked. */
export function listOption(
  option: ConfigOptionLike | undefined,
  category: ConfigCategory,
  agentName: string,
): string[] {
  const label = CATEGORY_LABEL[category];
  if (!option) return [`${agentName} offers no ${label} choice here.`];
  if (option.type === "boolean" || typeof option.currentValue === "boolean") {
    return [
      `${option.name}: ${option.currentValue ? "on" : "off"}   (/${commandFor(category)} on|off)`,
    ];
  }
  const choices = option.options ?? [];
  if (choices.length === 0)
    return [`${option.name}: ${String(option.currentValue)} (no other choices offered)`];
  const lines = [`${option.name}:`];
  choices.forEach((choice, i) => {
    const current = choice.value === option.currentValue;
    lines.push(
      `${current ? "●" : " "} ${i + 1}. ${choice.name}${choice.name !== choice.value ? `  (${choice.value})` : ""}${current ? "  current" : ""}`,
    );
  });
  lines.push(`/${commandFor(category)} <n|name> to switch`);
  return lines;
}

function commandFor(category: ConfigCategory): string {
  return Object.entries(CATEGORY_FOR_COMMAND).find(([, c]) => c === category)![0];
}

/**
 * Which value `arg` picks: a number from the list, an exact value or name, or
 * a unique prefix of one.
 */
export function pickOptionValue(
  option: ConfigOptionLike,
  arg: string,
): { value: string | boolean; name: string } | { error: string } {
  const wanted = arg.trim().toLowerCase();
  if (option.type === "boolean" || typeof option.currentValue === "boolean") {
    if (["on", "true", "yes", "1"].includes(wanted)) return { value: true, name: "on" };
    if (["off", "false", "no", "0"].includes(wanted)) return { value: false, name: "off" };
    return { error: `${option.name} is on or off` };
  }
  const choices = option.options ?? [];
  if (/^\d+$/.test(wanted)) {
    const choice = choices[Number(wanted) - 1];
    return choice
      ? { value: choice.value, name: choice.name }
      : { error: `choose 1-${choices.length}` };
  }
  const exact = choices.find(
    (c) => c.value.toLowerCase() === wanted || c.name.toLowerCase() === wanted,
  );
  if (exact) return { value: exact.value, name: exact.name };
  const partial = choices.filter(
    (c) => c.value.toLowerCase().includes(wanted) || c.name.toLowerCase().includes(wanted),
  );
  if (partial.length === 1) return { value: partial[0]!.value, name: partial[0]!.name };
  if (partial.length > 1)
    return { error: `'${arg}' matches ${partial.map((c) => c.name).join(", ")}` };
  return { error: `no ${option.name.toLowerCase()} called '${arg}'` };
}
