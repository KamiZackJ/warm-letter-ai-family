import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { ApiError } from "./errors.js";
import { isObject } from "./content-safety-http.js";

export interface WechatMessageQuery {
  signature?: string;
  timestamp?: string;
  nonce?: string;
  echostr?: string;
  encrypt_type?: string;
  msg_signature?: string;
}

export interface WechatMessageOptions {
  token: string;
  appId: string;
  encodingAesKey?: string;
  /** Only for legacy integrations. Production should use authenticated AES bodies. */
  allowPlaintext?: boolean;
  maxClockSkewSeconds?: number;
  now?: () => number;
}

export type MediaCheckCallback = {
  traceId: string;
  decision: "allow" | "reject" | "unavailable";
  reason?: "risky" | "review" | "provider";
  /** Numeric provider status only; never preserve errmsg or the original callback. */
  wechatErrorCode?: number;
};

function rejected(): never {
  throw new ApiError(400, "WECHAT_CALLBACK_INVALID", "微信回调校验失败");
}

function scalar(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return rejected();
  return String(value);
}

function decodeEntities(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/u.test(value)) return rejected();
  return value.replace(/&([^;]+);/gu, (_match, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity]!;
    const code = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isSafeInteger(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return rejected();
    return String.fromCodePoint(code);
  });
}

/** A deliberately small XML subset: bounded, no DTD/entities/attributes/namespaces/processing instructions. */
function parseXml(body: string): Record<string, unknown> {
  const source = body.replace(/^\uFEFF?\s*<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?\s*\?>/iu, "").trim();
  type Frame = { name: string; children: Record<string, unknown>; text: string; hasChildren: boolean };
  const frames: Frame[] = [];
  let index = 0;
  let result: Record<string, unknown> | undefined;
  let elements = 0;
  while (index < source.length) {
    const tail = source.slice(index);
    if (tail.startsWith("<![CDATA[")) {
      const end = source.indexOf("]]>", index + 9);
      if (end < 0 || !frames.length) return rejected();
      frames[frames.length - 1]!.text += source.slice(index + 9, end);
      index = end + 3;
      continue;
    }
    const close = /^<\/([A-Za-z_][A-Za-z0-9_]*)\s*>/u.exec(tail);
    if (close) {
      const frame = frames.pop();
      if (!frame || frame.name !== close[1] || (frame.hasChildren && frame.text.trim())) return rejected();
      const value: unknown = frame.hasChildren ? frame.children : frame.text;
      if (frames.length) {
        const parent = frames[frames.length - 1]!;
        parent.hasChildren = true;
        if (Object.hasOwn(parent.children, frame.name)) {
          const previous = parent.children[frame.name];
          parent.children[frame.name] = Array.isArray(previous) ? [...previous, value] : [previous, value];
        } else parent.children[frame.name] = value;
      } else {
        if (result || frame.name !== "xml" || !isObject(value)) return rejected();
        result = value;
      }
      index += close[0].length;
      continue;
    }
    const open = /^<([A-Za-z_][A-Za-z0-9_]*)\s*>/u.exec(tail);
    if (open) {
      if (++elements > 1024 || frames.length >= 16 || (result && !frames.length)) return rejected();
      frames.push({ name: open[1]!, children: Object.create(null) as Record<string, unknown>, text: "", hasChildren: false });
      index += open[0].length;
      continue;
    }
    if (tail.startsWith("<")) return rejected();
    const end = source.indexOf("<", index);
    const text = source.slice(index, end < 0 ? source.length : end);
    if (frames.length) frames[frames.length - 1]!.text += decodeEntities(text);
    else if (text.trim()) return rejected();
    index = end < 0 ? source.length : end;
  }
  if (frames.length || !result) return rejected();
  return result;
}

function parseBody(body: string | Buffer | Record<string, unknown>): Record<string, unknown> {
  if (isObject(body) && !Buffer.isBuffer(body)) {
    if (Buffer.byteLength(JSON.stringify(body)) > 128 * 1024) return rejected();
    return body;
  }
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : body;
  if (typeof text !== "string" || Buffer.byteLength(text) > 128 * 1024) return rejected();
  try {
    if (text.trimStart().startsWith("<")) return parseXml(text);
    const result: unknown = JSON.parse(text);
    if (!isObject(result)) return rejected();
    return result;
  } catch { return rejected(); }
}

export class WechatModerationCallbackVerifier {
  private readonly token: string;
  private readonly appId: string;
  private readonly key?: Buffer;
  private readonly allowPlaintext: boolean;
  private readonly maxClockSkew: number;
  private readonly now: () => number;

  constructor(options: WechatMessageOptions) {
    this.token = options.token;
    this.appId = options.appId;
    if (!/^[A-Za-z0-9]{3,32}$/u.test(this.token) || !this.appId.trim()) throw new Error("Invalid WeChat message configuration");
    if (options.encodingAesKey !== undefined) {
      if (!/^[A-Za-z0-9+/]{43}$/u.test(options.encodingAesKey)) throw new Error("Invalid WECHAT_ENCODING_AES_KEY");
      this.key = Buffer.from(`${options.encodingAesKey}=`, "base64");
      if (this.key.length !== 32 || this.key.toString("base64").slice(0, -1) !== options.encodingAesKey) throw new Error("Invalid WECHAT_ENCODING_AES_KEY");
    }
    this.allowPlaintext = options.allowPlaintext ?? false;
    if (!this.allowPlaintext && !this.key) throw new Error("WECHAT_ENCODING_AES_KEY is required for secure callbacks");
    this.maxClockSkew = options.maxClockSkewSeconds ?? 300;
    if (!Number.isSafeInteger(this.maxClockSkew) || this.maxClockSkew < 1 || this.maxClockSkew > 900) throw new Error("Invalid callback clock tolerance");
    this.now = options.now ?? Date.now;
  }

  verifyHandshake(query: WechatMessageQuery): string {
    this.verifySignature(query, query.signature);
    if (typeof query.echostr !== "string" || !query.echostr || query.echostr.length > 1024) return rejected();
    return query.echostr;
  }

  /** Returns null for another authenticated event. Caller should acknowledge it without mutation. */
  decodeMediaCheckCallback(query: WechatMessageQuery, body: string | Buffer | Record<string, unknown>): MediaCheckCallback | null {
    let message = parseBody(body);
    if (query.encrypt_type === "aes") {
      if (!this.key || typeof message.Encrypt !== "string") return rejected();
      this.verifySignature(query, query.msg_signature, message.Encrypt);
      message = parseBody(this.decrypt(message.Encrypt));
    } else {
      if (!this.allowPlaintext || query.encrypt_type || Object.hasOwn(message, "Encrypt")) return rejected();
      this.verifySignature(query, query.signature);
    }
    if (message.Event !== "wxa_media_check") return null;
    if (message.MsgType !== "event" || message.appid !== this.appId || scalar(message.version) !== "2") return rejected();
    const traceId = scalar(message.trace_id);
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(traceId)) return rejected();
    const errcode = scalar(message.errcode);
    if (!/^-?\d+$/u.test(errcode) || !Number.isSafeInteger(Number(errcode))) return rejected();
    if (errcode !== "0") return { traceId, decision: "unavailable", reason: "provider", wechatErrorCode: Number(errcode) };
    if (!isObject(message.result)) return rejected();
    const suggestion = message.result.suggest;
    if (suggestion === "pass") return { traceId, decision: "allow" };
    if (suggestion === "risky" || suggestion === "review") return { traceId, decision: "reject", reason: suggestion };
    return rejected();
  }

  private verifySignature(query: WechatMessageQuery, supplied: string | undefined, encrypted?: string): void {
    if (typeof query.timestamp !== "string" || !/^\d{10}$/u.test(query.timestamp) ||
      typeof query.nonce !== "string" || !query.nonce || query.nonce.length > 256 ||
      typeof supplied !== "string" || !/^[a-f0-9]{40}$/iu.test(supplied) ||
      Math.abs(this.now() / 1000 - Number(query.timestamp)) > this.maxClockSkew) return rejected();
    const values = [this.token, query.timestamp, query.nonce];
    if (encrypted !== undefined) values.push(encrypted);
    const expected = createHash("sha1").update(values.sort().join("")).digest();
    if (!timingSafeEqual(expected, Buffer.from(supplied, "hex"))) return rejected();
  }

  private decrypt(encrypted: string): string {
    try {
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encrypted)) return rejected();
      const data = Buffer.from(encrypted, "base64");
      if (data.length < 32 || data.length % 16 !== 0 || data.toString("base64") !== encrypted) return rejected();
      const decipher = createDecipheriv("aes-256-cbc", this.key!, this.key!.subarray(0, 16));
      decipher.setAutoPadding(false);
      const padded = Buffer.concat([decipher.update(data), decipher.final()]);
      const padding = padded[padded.length - 1]!;
      if (padding < 1 || padding > 32 || padding >= padded.length ||
        !padded.subarray(-padding).every((value) => value === padding)) return rejected();
      const plain = padded.subarray(0, -padding);
      if (plain.length < 20) return rejected();
      const length = plain.readUInt32BE(16);
      if (length > plain.length - 20 || plain.subarray(20 + length).toString("utf8") !== this.appId) return rejected();
      return plain.subarray(20, 20 + length).toString("utf8");
    } catch { return rejected(); }
  }
}
