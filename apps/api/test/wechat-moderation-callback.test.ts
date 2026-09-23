import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WechatModerationCallbackVerifier, type WechatMessageQuery } from "../src/wechat-moderation-callback.js";

const token = "syntheticMessageToken";
const appId = "wxSyntheticApp";
const timestamp = "1789473600";
const nonce = "synthetic-nonce";
const key = Buffer.alloc(32, 7);
const options = { token, appId, encodingAesKey: key.toString("base64").slice(0, -1), now: () => Number(timestamp) * 1000 };
const event = { MsgType: "event", Event: "wxa_media_check", appid: appId, version: 2, trace_id: "trace-id", errcode: 0, result: { suggest: "pass", label: 100 } };
const sign = (encrypted?: string): string => createHash("sha1").update([token, timestamp, nonce, ...(encrypted ? [encrypted] : [])].sort().join("")).digest("hex");

function envelope(message: string, tail = appId): { query: WechatMessageQuery; body: { Encrypt: string } } {
  const bytes = Buffer.from(message);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const content = Buffer.concat([Buffer.alloc(16, 1), length, bytes, Buffer.from(tail)]);
  const padding = 32 - content.length % 32;
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const Encrypt = Buffer.concat([cipher.update(Buffer.concat([content, Buffer.alloc(padding, padding)])), cipher.final()]).toString("base64");
  return { body: { Encrypt }, query: { timestamp, nonce, encrypt_type: "aes", msg_signature: sign(Encrypt) } };
}

describe("authenticated WeChat media callbacks", () => {
  it("accepts the published official AES compatibility vector", () => {
    const verifier = new WechatModerationCallbackVerifier({
      token: "AAAAA", appId: "wxba5fad812f8e6fb9", encodingAesKey: "A".repeat(43), now: () => 1714112445000,
    });
    const query = { timestamp: "1714112445", nonce: "415670741", encrypt_type: "aes", msg_signature: "046e02f8204d34f8ba5fa3b1db94908f3df2e9b3" };
    const body = { Encrypt: "+qdx1OKCy+5JPCBFWw70tm0fJGb2Jmeia4FCB7kao+/Q5c/ohsOzQHi8khUOb05JCpj0JB4RvQMkUyus8TPxLKJGQqcvZqzDpVzazhZv6JsXUnnR8XGT740XgXZUXQ7vJVnAG+tE8NUd4yFyjPy7GgiaviNrlCTj+l5kdfMuFUPpRSrfMZuMcp3Fn2Pede2IuQrKEYwKSqFIZoNqJ4M8EajAsjLY2km32IIjdf8YL/P50F7mStwntrA2cPDrM1kb6mOcfBgRtWygb3VIYnSeOBrebufAlr7F9mFUPAJGj04=" };
    // This is the documented debug_demo event, so it is authenticated then ignored.
    expect(verifier.decodeMediaCheckCallback(query, body)).toBeNull();
  });

  it("accepts the documented plaintext GET challenge even when POST requires AES", () => {
    const verifier = new WechatModerationCallbackVerifier(options);
    expect(verifier.verifyHandshake({ timestamp, nonce, signature: sign(), echostr: "challenge" })).toBe("challenge");
    expect(() => verifier.verifyHandshake({ timestamp, nonce, echostr: "challenge" })).toThrow("微信回调校验失败");
  });

  it.each(["pass", "review", "risky"])("authenticates AES JSON and maps %s without accepting async receipt", (suggest) => {
    const verifier = new WechatModerationCallbackVerifier(options);
    const { body, query } = envelope(JSON.stringify({ ...event, result: { suggest, label: 100 } }));
    expect(verifier.decodeMediaCheckCallback(query, body)).toMatchObject({ traceId: "trace-id", decision: suggest === "pass" ? "allow" : "reject" });
  });

  it("decrypts standard XML and CDATA, with duplicate detail items", () => {
    const verifier = new WechatModerationCallbackVerifier(options);
    const xml = `<xml><MsgType><![CDATA[event]]></MsgType><Event>wxa_media_check</Event><appid>${appId}</appid><version>2</version><trace_id>trace-id</trace_id><errcode>0</errcode><result><suggest>pass</suggest><label>100</label></result><detail><item><errcode>0</errcode></item><item><errcode>0</errcode></item></detail></xml>`;
    const { body, query } = envelope(xml);
    expect(verifier.decodeMediaCheckCallback(query, `<xml><Encrypt><![CDATA[${body.Encrypt}]]></Encrypt></xml>`)).toEqual({ traceId: "trace-id", decision: "allow" });
  });

  it("fails closed for signed provider errors, and ignores unrelated authenticated events", () => {
    const verifier = new WechatModerationCallbackVerifier(options);
    const unavailable = envelope(JSON.stringify({ ...event, errcode: -1008,
      errmsg: "sensitive raw upstream message", openid: "private-openid", media_url: "https://private.invalid/file?signature=secret" }));
    expect(verifier.decodeMediaCheckCallback(unavailable.query, unavailable.body)).toEqual({ traceId: "trace-id", decision: "unavailable", reason: "provider", wechatErrorCode: -1008 });
    const unrelated = envelope(JSON.stringify({ Event: "debug_demo" }));
    expect(verifier.decodeMediaCheckCallback(unrelated.query, unrelated.body)).toBeNull();
  });

  it("retains numeric XML error codes but rejects unsafe numeric callback codes", () => {
    const verifier = new WechatModerationCallbackVerifier(options);
    const xml = `<xml><MsgType>event</MsgType><Event>wxa_media_check</Event><appid>${appId}</appid><version>2</version><trace_id>xml-trace</trace_id><errcode>40001</errcode><errmsg>must not persist</errmsg></xml>`;
    const signed = envelope(xml);
    expect(verifier.decodeMediaCheckCallback(signed.query, signed.body)).toEqual({ traceId: "xml-trace", decision: "unavailable", reason: "provider", wechatErrorCode: 40001 });
    const unsafe = envelope(JSON.stringify({ ...event, errcode: "9007199254740993" }));
    expect(() => verifier.decodeMediaCheckCallback(unsafe.query, unsafe.body)).toThrow("微信回调校验失败");
  });

  it("rejects stale, absent, forged, wrong-app and mode-downgraded signatures", () => {
    const verifier = new WechatModerationCallbackVerifier(options);
    const { body, query } = envelope(JSON.stringify(event));
    for (const altered of [
      { ...query, timestamp: String(Number(timestamp) - 301) },
      { ...query, msg_signature: undefined, signature: sign() },
      { ...query, msg_signature: "0".repeat(40) },
      { ...query, encrypt_type: undefined, signature: sign() },
    ]) expect(() => verifier.decodeMediaCheckCallback(altered, body)).toThrow("微信回调校验失败");
    const wrongApp = envelope(JSON.stringify(event), "wxOtherApp");
    expect(() => verifier.decodeMediaCheckCallback(wrongApp.query, wrongApp.body)).toThrow("微信回调校验失败");
    expect(() => verifier.decodeMediaCheckCallback({ timestamp, nonce, signature: sign() }, event)).toThrow("微信回调校验失败");
  });

  it("allows explicitly configured signed legacy JSON/XML but never unsigned bodies", () => {
    const verifier = new WechatModerationCallbackVerifier({ ...options, allowPlaintext: true });
    const query = { timestamp, nonce, signature: sign() };
    expect(verifier.decodeMediaCheckCallback(query, event)).toMatchObject({ decision: "allow" });
    expect(() => verifier.decodeMediaCheckCallback({ timestamp, nonce }, event)).toThrow();
    expect(() => verifier.decodeMediaCheckCallback(query, { ...event, appid: "other" })).toThrow();
  });

  it.each([
    '<!DOCTYPE xml [<!ENTITY exploit SYSTEM "file:///etc/passwd">]><xml><Event>&exploit;</Event></xml>',
    '<xml><Event attr="x">wxa_media_check</Event></xml>',
    '<xml><Event>&unknown;</Event></xml>',
    '<xml><Event>one</Event><Event>two</Event></xml><xml></xml>',
    `<xml>${"<nested>".repeat(20)}x${"</nested>".repeat(20)}</xml>`,
  ])("rejects unsafe or ambiguous XML", (xml) => {
    const verifier = new WechatModerationCallbackVerifier(options);
    const { query, body } = envelope(xml);
    expect(() => verifier.decodeMediaCheckCallback(query, body)).toThrow("微信回调校验失败");
  });

  it("rejects duplicate decision fields, missing final decisions, and oversized callbacks", () => {
    const verifier = new WechatModerationCallbackVerifier(options);
    for (const value of [{ ...event, result: {} }, { ...event, version: [2, 2] }, { ...event, trace_id: ["a", "b"] }]) {
      const { query, body } = envelope(JSON.stringify(value));
      expect(() => verifier.decodeMediaCheckCallback(query, body)).toThrow("微信回调校验失败");
    }
    expect(() => verifier.decodeMediaCheckCallback({}, "a".repeat(128 * 1024 + 1))).toThrow();
  });
});
