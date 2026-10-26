/**
 * Reading an image off the desktop's disk for a phone that cannot see it.
 *
 * Agents display pictures by *naming a file*: an ACP `resource_link`, an
 * embedded resource, or plain markdown like `![](.gg/generated/plot.png)`. On
 * the machine running the agent that renders; on the phone it is a blank box.
 * The daemon is the only process that can read that path, so it turns it into
 * a data URI the app can paint.
 *
 * The path arrives from the *agent*, not from a trusted UI, so it is treated as
 * untrusted input: resolved, symlink-followed, then checked to be inside a root
 * the user already exposed by running a session there. Everything here is pure
 * apart from the two injected fs calls, so the containment rules are testable.
 */
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Formats React Native's `Image` can actually paint. SVG is deliberately absent:
 * it needs a renderer the app does not ship, and inlining it would produce a
 * silent empty frame rather than a picture.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

/**
 * Above this the transfer costs more than the picture is worth on a phone.
 *
 * Base64 inflates by a third, so 8MB leaves roughly 11MB on the wire — inside
 * the Durable Object's 32 MiB received-message ceiling, which is the hard limit
 * the remote path would otherwise hit as a socket that simply dies. The daemon
 * ships no image library and cannot downscale, so it declines and says why.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** The mime type for a path, or undefined when it is not a paintable image. */
export function imageMimeType(path: string): string | undefined {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()];
}

/**
 * Turn whatever the agent wrote into an absolute path.
 *
 * `file://` URLs, `~`, and paths relative to the session's working directory
 * are all normal in agent output. A URI with any other scheme is not on this
 * disk and returns undefined, so callers never accidentally read `http:` as a
 * relative filename.
 */
export function toLocalPath(
  uri: string,
  cwd: string,
  home: string = homedir(),
): string | undefined {
  const raw = uri.trim();
  if (!raw) return undefined;

  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw);
    } catch {
      return undefined;
    }
  }
  // Any other scheme (http:, data:, mcp:) is not a file on this machine.
  //
  // A Windows drive letter is not a scheme, though it parses as one. `C:\Users`
  // matched this, so every absolute Windows path was refused as "not a file on
  // this machine" and no agent-produced image could load there at all. A scheme
  // is at least two characters where a drive letter is exactly one — the one
  // rule that separates them without the code having to know the platform.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(raw)) return undefined;
  // A lone letter and colon is a drive only when a separator follows. `x:foo`
  // is a path relative to that drive's current directory, which is not
  // something an agent means and would resolve outside the session's cwd.
  if (/^[a-zA-Z]:/.test(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) return undefined;

  if (raw === "~") return home;
  if (raw.startsWith("~/")) return resolve(home, raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
}

/** True when `path` is `root` or sits underneath it. */
function isInside(path: string, root: string): boolean {
  const base = resolve(root);
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * The directories an image may be read from.
 *
 * The session's own working directory is the point: the user pointed an agent
 * at that project, so its files are already in play. The temp directories are
 * included because generation and screenshot tools routinely write there
 * before anything is committed — both the per-user one (`tmpdir()`, under
 * `/var/folders` on macOS) and the shared `/tmp` agents reach for by name.
 * Nothing else — the pairing token is a bearer secret, and a stolen one must
 * not turn into "read any file on the machine as a picture"; and only image
 * extensions are ever served from any of them.
 */
export function allowedImageRoots(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const roots = [resolve(cwd), resolve(tmpdir())];
  if (platform !== "win32") roots.push("/tmp");
  if (env.PEW2_IMAGE_ROOTS) {
    for (const extra of env.PEW2_IMAGE_ROOTS.split(":")) {
      if (extra.trim()) roots.push(resolve(extra.trim()));
    }
  }
  return roots;
}

/** An ACP image block, as the app's content parser expects to receive it. */
export interface ImageBlock {
  type: "image";
  mimeType: string;
  data: string;
}

export type HistoryImage =
  | ImageBlock
  | {
      type: "resource_link";
      uri: string;
      name: string;
      mimeType?: string;
    };

/**
 * Pictures inside a message read from an agent's own on-disk history.
 *
 * The JSONL formats are not ACP: an attached or generated image is stored the
 * way the underlying model API took it — Anthropic's `{ source: { data } }`, or
 * an OpenAI-style `image_url`. Local replay flattens messages to text, so
 * without this a resumed conversation silently lost every picture it contained
 * while the live stream showed them fine.
 */
export function historyImages(
  content: unknown,
  resolveData?: (data: string) => string | undefined,
): HistoryImage[] {
  if (!Array.isArray(content)) return [];
  const images: HistoryImage[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;

    // OG Coder keeps a picture's bytes beside the conversation and leaves a
    // marker in their place. Resolved when the caller can; otherwise skipped,
    // because painting the marker would show a broken image.
    if (
      part.type === "image" &&
      typeof part.data === "string" &&
      part.data.startsWith(SESSION_ASSET_PREFIX)
    ) {
      const data = resolveData?.(part.data);
      if (data) {
        images.push({ type: "image", mimeType: imageMime(part) ?? "image/png", data });
      }
      continue;
    }

    // Anthropic: { type: "image", source: { type: "base64", media_type, data } }
    const source = part.source;
    if (part.type === "image" && source?.type === "base64" && typeof source.data === "string") {
      images.push({
        type: "image",
        mimeType: typeof source.media_type === "string" ? source.media_type : "image/png",
        data: source.data,
      });
      continue;
    }

    // Already ACP-shaped, which is what GG Coder stores (as `mediaType`).
    if (part.type === "image" && typeof part.data === "string") {
      images.push({
        type: "image",
        mimeType: imageMime(part) ?? "image/png",
        data: part.data,
      });
      continue;
    }

    if (part.type === "resource_link" && typeof part.uri === "string") {
      images.push({
        type: "resource_link",
        uri: part.uri,
        name: typeof part.name === "string" ? part.name : "Image",
        ...(typeof part.mimeType === "string" ? { mimeType: part.mimeType } : {}),
      });
      continue;
    }

    // OpenAI: { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
    const url = part.image_url?.url ?? part.imageUrl?.url;
    if (typeof url === "string") {
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
      if (match) images.push({ type: "image", mimeType: match[1]!, data: match[2]! });
      // Retain the reference, not a new fetch. The app's existing URI rules and
      // the daemon's image-file containment checks still apply when it is shown.
      else if (/^https?:\/\//i.test(url)) {
        images.push({ type: "resource_link", uri: url, name: "Image" });
      }
    }
  }
  return images;
}

/** OG Coder's marker for a picture it read from a file: the bytes stay in the file. */
export const SESSION_ASSET_PREFIX = "gg-session-asset:";
const OMITTED_IMAGE_NOTE =
  /^\[Session storage omitted duplicated image data; read the source again at (.+)\.\]$/;

function imageMime(part: { mimeType?: unknown; mediaType?: unknown }): string | undefined {
  if (typeof part.mimeType === "string") return part.mimeType;
  if (typeof part.mediaType === "string") return part.mediaType;
  return undefined;
}

/**
 * Only explicit tool-result blocks contribute pictures, never arbitrary tool text.
 *
 * One exception, and only inside a tool result: OG Coder stores a picture a
 * tool read from disk (a screenshot, say) as a note naming that file instead of
 * its bytes. The note is OG Coder's own exact sentence, so it is turned back
 * into the picture by path — fetched like any other, under the same rules.
 */
export function historyToolImages(
  content: unknown,
  resolveData?: (data: string) => string | undefined,
): HistoryImage[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (part?.type !== "tool_result") return [];
    const images = historyImages(part.content, resolveData);
    if (Array.isArray(part.content)) {
      for (const item of part.content) {
        if (item?.type !== "text" || typeof item.text !== "string") continue;
        const path = OMITTED_IMAGE_NOTE.exec(item.text.trim())?.[1];
        const mimeType = path ? imageMimeType(path) : undefined;
        if (path && mimeType) {
          images.push({
            type: "resource_link",
            uri: path,
            name: path.split("/").pop() ?? "Image",
            mimeType,
          });
        }
      }
    }
    return images;
  });
}

export interface LoadedImage {
  dataUri: string;
  mimeType: string;
}

/**
 * A file already open, so nothing about it can be swapped underneath.
 *
 * Size and kind are read from the descriptor rather than the path, which is
 * what makes the checks below apply to the bytes actually returned.
 */
export interface ImageFile {
  size: number;
  isFile: () => boolean;
  read: () => Promise<Buffer>;
  close: () => Promise<void>;
}

export interface ImageFs {
  realpath: (path: string) => Promise<string>;
  /** Open for reading, refusing a final component that is a symlink. */
  open: (path: string) => Promise<ImageFile>;
}

/**
 * The real filesystem. Exported so the descriptor-based read can be tested
 * against an actual symlink rather than a stub that reimplements it.
 */
export const nodeImageFs: ImageFs = {
  realpath,
  open: async (path) => {
    // O_NOFOLLOW: between the containment check and this call, the checked path
    // can be replaced with a link pointing anywhere. `realpath` proved the name
    // resolved inside an allowed root a moment ago, not that it still does.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    return {
      size: info.size,
      isFile: () => info.isFile(),
      read: () => handle.readFile(),
      close: () => handle.close(),
    };
  },
};

/**
 * Read one image and inline it, or explain why not.
 *
 * Throws with a sentence meant for the user: the app renders the failure in
 * place of the picture, and "blank box, no reason" is the bug this whole path
 * exists to remove.
 */
export async function loadImage(
  uri: string,
  options: { cwd: string; env?: NodeJS.ProcessEnv; fs?: ImageFs; home?: string },
): Promise<LoadedImage> {
  const fs = options.fs ?? nodeImageFs;
  const path = toLocalPath(uri, options.cwd, options.home);
  if (!path) throw new Error(`'${uri}' is not a file on this machine`);

  const mimeType = imageMimeType(path);
  if (!mimeType) throw new Error(`'${uri}' is not an image this app can display`);

  // Resolve symlinks *before* the containment check: `project/link -> /etc` is
  // otherwise inside the root by spelling alone.
  let real: string;
  try {
    real = resolve(await fs.realpath(path));
  } catch {
    throw new Error(`'${uri}' was not found`);
  }

  // Roots are resolved the same way as the file. On macOS `/tmp` and
  // `/var/folders/...` are symlinks, so comparing a real path against a spelled
  // root rejects files that are plainly inside the project.
  const roots = await Promise.all(
    allowedImageRoots(options.cwd, options.env).map(async (root) => {
      try {
        return resolve(await fs.realpath(root));
      } catch {
        return root;
      }
    }),
  );
  if (!roots.some((root) => isInside(real, root))) {
    throw new Error(`'${uri}' is outside this session's project directory`);
  }

  // Opened once, and measured and read through that one descriptor.
  //
  // Resolving, then stat-ing, then reading re-resolved the name three times, and
  // an attacker who could write anywhere in the path only had to win the gap
  // between the check and the read — the size limit and the containment check
  // then described a different file from the one whose bytes were sent. What is
  // still resolved by name is the directories above it, which Node offers no way
  // to hold open; that needs write access to a directory inside an allowed root,
  // which is a far narrower position than replacing a file.
  let file: ImageFile;
  try {
    file = await fs.open(real);
  } catch {
    throw new Error(`'${uri}' was not found`);
  }

  try {
    if (!file.isFile()) throw new Error(`'${uri}' is not a file`);
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `'${uri}' is ${Math.round(file.size / 1024 / 1024)}MB, too large to send to the app`,
      );
    }

    const bytes = await file.read();
    return { mimeType, dataUri: `data:${mimeType};base64,${bytes.toString("base64")}` };
  } finally {
    // Left open, this leaks a descriptor per picture viewed — and the app fetches
    // one per image in a conversation.
    await file.close().catch(() => {});
  }
}
