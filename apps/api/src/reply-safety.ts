import { ApiError } from "./errors.js";

export const MAX_REPLY_TEXT_LENGTH = 240;
export const MAX_REPLY_AUTHOR_LENGTH = 40;

const forbiddenControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u;
const rejectedContentPatterns = [
  // 违法行为的明确求助、教学或交易意图。
  /(?:教我|告诉我|提供|怎么|如何|帮我).{0,10}(?:诈骗|洗钱|制毒|贩毒|盗窃|偷窃|入侵(?:账号|系统)|伪造(?:证件|身份证)|制造炸弹|制作爆炸物)/u,
  /(?:购买|出售|贩卖|交易).{0,6}(?:毒品|枪支|假证|人口)/u,
  // 低俗或淫秽内容的索取、传播和交易。
  /(?:发给我|给我看|传播|上传|售卖).{0,8}(?:裸照|成人视频|色情(?:图片|视频)|淫秽(?:图片|视频))/u,
  /(?:约炮|卖淫|嫖娼)/u,
  // 暴力威胁、伤害意图或鼓励他人自伤。
  /(?:我要|我会|准备|想要|一起|帮我|替我).{0,8}(?:杀(?:了|掉|死)?(?:你|他|她|人)|弄死|砍死|打死|伤害|放火|爆炸)/u,
  /(?:杀了你|弄死你|砍死你|打死你)/u,
  /(?:你|妳|你们).{0,6}(?:去死|自杀|跳楼|割腕)/u,
  /^(?:赶紧|立刻|马上)?去死吧?$/u,
  // 针对民族、地域、性别等群体的贬损表达。
  /[\p{Script=Han}A-Za-z0-9·]{1,16}(?:族|人|群体|民族|性别)(?:都是|全是|天生就是?|就该)(?:垃圾|废物|低等|恶心|该死|滚出去)/u,
  // 针对个人的侮辱和攻击性命令。
  /(?:你|妳|你们|他|她|他们|她们|这人|那人|某某).{0,6}(?:废物|垃圾|蠢货|白痴|傻逼|煞笔|傻比|畜生|人渣|贱人|婊子|狗东西)/u,
  /(?:滚开|滚蛋|闭嘴).{0,4}(?:傻逼|煞笔|傻比|蠢货|白痴|废物|人渣|贱人)/u,
  /(?:傻逼|煞笔|傻比|操你妈|草泥马)/u,
] as const;

export interface ReplySafetyPolicy {
  validate(text: string): string | Promise<string>;
}

export class DeterministicReplySafetyPolicy implements ReplySafetyPolicy {
  validate(text: string): string {
    const normalized = text.normalize("NFKC").trim();
    if (!normalized) {
      throw new ApiError(400, "INVALID_REPLY", "回复内容不能为空");
    }
    if (Array.from(normalized).length > MAX_REPLY_TEXT_LENGTH) {
      throw new ApiError(
        400,
        "REPLY_TOO_LONG",
        `回复内容不能超过 ${MAX_REPLY_TEXT_LENGTH} 个字`,
      );
    }
    if (forbiddenControls.test(normalized)) {
      throw new ApiError(400, "INVALID_REPLY", "回复包含不可用字符，请修改后再试");
    }
    const compact = normalized.replace(/[\s\p{P}\p{S}]+/gu, "");
    if (rejectedContentPatterns.some((pattern) => pattern.test(compact))) {
      throw new ApiError(422, "REPLY_CONTENT_REJECTED", "回复包含不适合发送的内容，请修改后再试");
    }
    return normalized;
  }
}

export function normalizeReplyAuthor(authorName: string | undefined): string {
  const normalized = authorName?.normalize("NFKC").trim() || "家人";
  if (
    Array.from(normalized).length > MAX_REPLY_AUTHOR_LENGTH ||
    forbiddenControls.test(normalized)
  ) {
    throw new ApiError(400, "INVALID_REPLY_AUTHOR", "回复称呼不符合要求");
  }
  return normalized;
}
