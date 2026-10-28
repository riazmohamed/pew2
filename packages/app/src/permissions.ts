/**
 * Reading an approval request, from wherever it reached this device.
 *
 * The same request arrives by two routes that look nothing alike: live, as a
 * `permission_request` session event while the socket is up, and on reconnect,
 * as the daemon's list of what the agent is *still* blocked on. Both end up in
 * front of the same sheet with the same buttons, so both are read here — the
 * alternative was two copies of the defaulting below, and a phone that came
 * back from a signal drop offering "Allow/Reject" for a request whose real
 * options were "Yes, and don't ask again".
 *
 * Expo-free so it can be tested directly.
 */
import type { PermissionRequest } from "./useDaemon";

/** The shape an agent sends, of which everything is optional in practice. */
interface PermissionParams {
  toolCall?: {
    title?: string;
    rawInput?: unknown;
    content?: unknown;
    locations?: unknown;
  };
  options?: { optionId: string; name: string }[];
}

/**
 * Fallback buttons, for an agent that asks without offering any.
 *
 * A sheet with no options is unanswerable, and an unanswerable sheet stops the
 * turn exactly as dead as no sheet at all.
 */
const DEFAULT_OPTIONS = [
  { optionId: "allow", name: "Allow" },
  { optionId: "reject", name: "Reject" },
];

/** One open request, from its `requestId` and the agent's raw params. */
export function toPermissionRequest(requestId: string, params: unknown): PermissionRequest {
  const fields = (params ?? {}) as PermissionParams;
  const title = fields.toolCall?.title ?? "The agent needs your approval";
  const details = permissionDetails(fields.toolCall, title);
  return {
    requestId,
    title,
    ...(details ? { details } : {}),
    options:
      Array.isArray(fields.options) && fields.options.length > 0 ? fields.options : DEFAULT_OPTIONS,
  };
}

/** Long enough for a real diff, short enough not to stall the sheet. */
const DETAILS_MAX = 4000;

/** Input fields that name what is touched, in the order they are shown. */
const INPUT_KEYS = ["command", "cmd", "file_path", "path", "url", "pattern", "query"] as const;

/**
 * The request's details as plain text: the command, the paths, any text or
 * diff the agent attached. Undefined when there is nothing beyond the title.
 */
export function permissionDetails(
  toolCall: PermissionParams["toolCall"],
  title?: string,
): string | undefined {
  if (!toolCall || typeof toolCall !== "object") return undefined;
  const lines: string[] = [];
  const add = (line: string) => {
    const trimmed = line.trim();
    if (trimmed && trimmed !== title?.trim() && !lines.includes(trimmed)) lines.push(trimmed);
  };

  const input = toolCall.rawInput;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const key of INPUT_KEYS) {
      const value = record[key];
      if (typeof value === "string") add(key === "command" || key === "cmd" ? `$ ${value}` : value);
      else if (Array.isArray(value) && value.every((part) => typeof part === "string"))
        add(`$ ${value.join(" ")}`);
    }
  } else if (typeof input === "string") add(input);

  if (Array.isArray(toolCall.locations)) {
    for (const location of toolCall.locations as { path?: unknown; line?: unknown }[]) {
      if (typeof location?.path !== "string") continue;
      add(typeof location.line === "number" ? `${location.path}:${location.line}` : location.path);
    }
  }

  if (Array.isArray(toolCall.content)) {
    for (const block of toolCall.content as Record<string, unknown>[]) {
      if (block?.type === "diff" && typeof block.newText === "string") {
        const path = typeof block.path === "string" ? block.path : "";
        const old = typeof block.oldText === "string" ? block.oldText : "";
        const diff = [
          ...(old ? old.split("\n").map((line) => `- ${line}`) : []),
          ...block.newText.split("\n").map((line) => `+ ${line}`),
        ].join("\n");
        add(path ? `${path}\n${diff}` : diff);
      } else if (block?.type === "content") {
        const inner = block.content as { type?: unknown; text?: unknown } | undefined;
        if (inner?.type === "text" && typeof inner.text === "string") add(inner.text);
      }
    }
  }

  if (lines.length === 0) return undefined;
  const text = lines.join("\n\n");
  return text.length > DETAILS_MAX ? `${text.slice(0, DETAILS_MAX)}…` : text;
}

/** A live `permission_request` event payload, or undefined for any other event. */
export function readPermissionRequest(payload: unknown): PermissionRequest | undefined {
  const event = payload as { kind?: string; requestId?: unknown; params?: unknown } | undefined;
  if (event?.kind !== "permission_request" || typeof event.requestId !== "string") return undefined;
  return toPermissionRequest(event.requestId, event.params);
}

/**
 * The request to put on screen, from the daemon's catch-up list.
 *
 * The newest, because that is what live does: a second request arriving while
 * the first is up replaces it. Matching that here means a reconnect shows what
 * the phone would have been showing had it never dropped, rather than an older
 * request the screen had already moved past.
 *
 * Undefined for an absent field — an older daemon that does not send one — and
 * *only* for that. An empty array is a daemon that says nothing is pending,
 * which is a fact worth carrying: it is what dismisses a sheet the user
 * answered on the desktop while this phone was offline.
 */
export function pendingPermission(permissions: unknown): PermissionRequest | undefined | null {
  if (!Array.isArray(permissions)) return undefined;
  const open = permissions.filter(
    (entry): entry is { requestId: string; params?: unknown } =>
      typeof entry?.requestId === "string",
  );
  const last = open[open.length - 1];
  return last ? toPermissionRequest(last.requestId, last.params) : null;
}
