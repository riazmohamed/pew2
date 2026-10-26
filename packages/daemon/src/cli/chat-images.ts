/**
 * Pictures in `pew2 chat`: which events carry one, how iTerm2 draws one inline
 * (OSC 1337), and how a screenshot or a dropped file becomes a prompt
 * attachment inside the wire limits. Pure; `chat.ts` does the I/O.
 */
import { wire } from "@pew2/protocol";
import { isImageSource } from "./chat-markdown.js";

export interface ChatImage {
  /** A `data:` URI, or the path/URL the daemon has to fetch. */
  src: string;
  name: string;
}

function baseName(src: string): string {
  if (src.startsWith("data:")) return "image";
  return src.split("?")[0]!.split(/[\\/]/).pop() || "image";
}

function isImageMime(mimeType: unknown): mimeType is string {
  return (
    typeof mimeType === "string" &&
    mimeType.startsWith("image/") &&
    !mimeType.toLowerCase().startsWith("image/svg")
  );
}

/** An image in one ACP content block, as the app reads them. */
function imageFromBlock(block: unknown): ChatImage | undefined {
  const b = block as {
    type?: unknown;
    mimeType?: unknown;
    data?: unknown;
    uri?: unknown;
    name?: unknown;
    resource?: { mimeType?: unknown; blob?: unknown; uri?: unknown };
  } | null;
  if (!b || typeof b !== "object") return undefined;
  if (b.type === "image") {
    if (b.mimeType !== undefined && !isImageMime(b.mimeType)) return undefined;
    const mimeType = isImageMime(b.mimeType) ? b.mimeType : "image/png";
    if (typeof b.data === "string" && b.data)
      return { src: `data:${mimeType};base64,${b.data}`, name: "image" };
    if (typeof b.uri === "string" && b.uri) return { src: b.uri, name: baseName(b.uri) };
    return undefined;
  }
  if (b.type === "resource_link") {
    const uri = typeof b.uri === "string" ? b.uri : "";
    if (!uri || (!isImageMime(b.mimeType) && !isImageSource(uri))) return undefined;
    return { src: uri, name: typeof b.name === "string" && b.name ? b.name : baseName(uri) };
  }
  if (b.type === "resource" && b.resource && typeof b.resource === "object") {
    const r = b.resource;
    if (typeof r.blob === "string" && r.blob && isImageMime(r.mimeType)) {
      return { src: `data:${r.mimeType};base64,${r.blob}`, name: "image" };
    }
    const uri = typeof r.uri === "string" ? r.uri : "";
    if (uri && (isImageMime(r.mimeType) || isImageSource(uri)))
      return { src: uri, name: baseName(uri) };
  }
  return undefined;
}

/** Every image in a `content` field, which may be one block or an array. */
export function imagesFromContent(content: unknown): ChatImage[] {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map(imageFromBlock).filter((image): image is ChatImage => image !== undefined);
}

/** Images a tool call produced (its `content` entries of type `content`). */
export function imagesFromToolContent(content: unknown): ChatImage[] {
  if (!Array.isArray(content)) return [];
  const out: ChatImage[] = [];
  for (const entry of content as { type?: unknown; content?: unknown }[]) {
    if (entry?.type === "content") out.push(...imagesFromContent(entry.content));
  }
  return out;
}

/** Pictures among a user's attachments, as the daemon echoes them in `user_message`. */
export function imagesFromAttachments(attachments: unknown): ChatImage[] {
  if (!Array.isArray(attachments)) return [];
  const out: ChatImage[] = [];
  for (const file of attachments as { uri?: unknown; mimeType?: unknown; name?: unknown }[]) {
    const uri = typeof file?.uri === "string" ? file.uri : "";
    if (!uri || (!isImageMime(file.mimeType) && !isImageSource(uri))) continue;
    out.push({
      src: uri,
      name: typeof file.name === "string" && file.name ? file.name : baseName(uri),
    });
  }
  return out;
}

/** Can this terminal draw pictures with iTerm2's inline image protocol? */
export function supportsInlineImages(env: Record<string, string | undefined>): boolean {
  return env.TERM_PROGRAM === "iTerm.app" || env.LC_TERMINAL === "iTerm2";
}

/** Split a `data:` URI into its mime type and base64 body. */
export function parseDataUri(dataUri: string): { mimeType: string; base64: string } | undefined {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(dataUri);
  return match ? { mimeType: match[1]!, base64: match[2]! } : undefined;
}

/**
 * iTerm2's inline image escape. Width is in cells, capped to `maxFraction` of
 * the window so a big screenshot does not swamp the conversation.
 */
export function osc1337(base64: string, name: string, columns: number, maxFraction = 0.6): string {
  const bytes = Math.floor((base64.replace(/=+$/, "").length * 3) / 4);
  const width = Math.max(10, Math.floor(columns * maxFraction));
  const encodedName = Buffer.from(name).toString("base64");
  return `\x1b]1337;File=name=${encodedName};size=${bytes};width=${width};preserveAspectRatio=1;inline=1:${base64}\x07`;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/** The image mime type for a file name, or undefined for anything else. */
export function imageMimeForPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext];
}

/**
 * `/attach <path> [message]`: the path as a terminal pastes it when a file is
 * dropped on the window (quoted, or with backslash-escaped spaces, or as a
 * `file://` URL), and whatever follows it.
 */
export function parseAttachArgs(
  arg: string,
  home = "",
): { path: string; message: string } | undefined {
  const text = arg.trim();
  if (!text) return undefined;
  let path = "";
  let i = 0;
  const quote = text[0] === "'" || text[0] === '"' ? text[0] : undefined;
  if (quote) {
    const end = text.indexOf(quote, 1);
    if (end < 0) return undefined;
    path = text.slice(1, end);
    i = end + 1;
  } else {
    while (i < text.length && text[i] !== " ") {
      if (text[i] === "\\" && i + 1 < text.length) {
        path += text[i + 1];
        i += 2;
        continue;
      }
      path += text[i];
      i++;
    }
  }
  if (path.startsWith("file://")) path = decodeURIComponent(path.slice(7));
  if (path === "~" || path.startsWith("~/")) path = `${home}${path.slice(1)}`;
  return { path, message: text.slice(i).trim() };
}

export type Attachment = { name: string; mimeType: string; data: string };

/**
 * One file as a prompt attachment, refused when over the wire's one-file
 * ceiling, with the same wording style the daemon uses.
 */
export function buildAttachment(
  name: string,
  mimeType: string,
  bytes: Uint8Array,
): { attachment: Attachment } | { error: string } {
  if (bytes.byteLength === 0) return { error: `'${name}' is empty` };
  if (bytes.byteLength > wire.MAX_ATTACHMENT_BYTES) {
    return {
      error: `'${name}' is ${megabytes(bytes.byteLength)}, over the ${megabytes(wire.MAX_ATTACHMENT_BYTES)} limit for one file`,
    };
  }
  return { attachment: { name, mimeType, data: Buffer.from(bytes).toString("base64") } };
}

/** The per-message limits (count and total), checked before sending. */
export function attachmentsError(attachments: readonly Attachment[]): string | undefined {
  if (attachments.length > wire.MAX_ATTACHMENTS) {
    return `too many attachments: ${attachments.length}, limit is ${wire.MAX_ATTACHMENTS}`;
  }
  let total = 0;
  for (const a of attachments) {
    const size = Math.floor((a.data.replace(/=+$/, "").length * 3) / 4);
    if (size > wire.MAX_ATTACHMENT_BYTES)
      return `'${a.name}' is over the ${megabytes(wire.MAX_ATTACHMENT_BYTES)} limit`;
    total += size;
  }
  if (total > wire.MAX_ATTACHMENTS_TOTAL_BYTES) {
    return `attachments total ${megabytes(total)}, over the ${megabytes(wire.MAX_ATTACHMENTS_TOTAL_BYTES)} limit`;
  }
  return undefined;
}

/** Downscale when the picture is big enough to matter on the wire. */
export function needsDownscale(bytes: number, maxDimension: number, limit = 1800): boolean {
  return maxDimension > limit || bytes > wire.MAX_ATTACHMENT_BYTES / 2;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** A screenshot's file name: sortable, local time supplied by the caller. */
export function screenshotName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `screenshot-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
}
