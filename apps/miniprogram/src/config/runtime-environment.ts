export const DEPLOYMENT_MODES = ["demo", "test", "competition", "production"] as const;
export const API_MODES = ["mock", "real"] as const;
export const ACCOUNT_ENVIRONMENTS = ["develop", "trial", "release"] as const;

export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];
export type ApiMode = (typeof API_MODES)[number];
export type AccountEnvironment = (typeof ACCOUNT_ENVIRONMENTS)[number];

export type MiniProgramEnvironmentInput = {
  deploymentMode: unknown;
  apiMode: unknown;
  apiBaseUrl: unknown;
  requestTimeoutMs: unknown;
  accountEnvironment: unknown;
  appId: unknown;
};

export type MiniProgramEnvironment = {
  deploymentMode: DeploymentMode;
  apiMode: ApiMode;
  apiBaseUrl: string;
  healthUrl: string;
  requestTimeoutMs: number;
  accountEnvironment: AccountEnvironment;
  appId: string;
  demoEnabled: boolean;
  environmentLabel: string;
  environmentDetail: string;
  storageNamespace: string;
};

export class MiniProgramConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MiniProgramConfigurationError";
  }
}

function requireEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  fieldName: string,
): T {
  if (typeof value !== "string" || !values.includes(value.trim() as T)) {
    throw new MiniProgramConfigurationError(`${fieldName} 必须是 ${values.join("、")} 之一`);
  }
  return value.trim() as T;
}

function ipv4Octets(hostname: string): number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 0xff) ? octets : undefined;
}

function ipv6Words(value: string): number[] | undefined {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname.includes(":") || hostname.split("::").length > 2) return undefined;
  const [headText, tailText] = hostname.split("::");
  const compressed = hostname.includes("::");
  const parseSide = (text: string | undefined): number[] | undefined => {
    if (!text) return [];
    const segments = text.split(":");
    const words: number[] = [];
    for (const segment of segments) {
      if (segment.includes(".")) {
        const octets = ipv4Octets(segment);
        if (!octets) return undefined;
        words.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(segment)) return undefined;
      words.push(Number.parseInt(segment, 16));
    }
    return words;
  };
  const head = parseSide(headText);
  const tail = parseSide(tailText);
  if (!head || !tail) return undefined;
  const explicitCount = head.length + tail.length;
  if ((!compressed && explicitCount !== 8) || (compressed && explicitCount >= 8)) {
    return undefined;
  }
  return compressed
    ? [...head, ...Array<number>(8 - explicitCount).fill(0), ...tail]
    : [...head, ...tail];
}

function embeddedIpv4FromIpv6(words: number[]): number[] | undefined {
  const isMapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const isCompatible = words.slice(0, 6).every((word) => word === 0);
  if (!isMapped && !isCompatible) return undefined;
  return [words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff];
}

function isAmbiguousIpv4Literal(hostname: string): boolean {
  if (/^(?:0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(hostname)) return true;

  const parts = hostname.split(".");
  if (!parts.every((part) => /^(?:0x[0-9a-f]+|\d+)$/i.test(part))) return false;
  return (
    parts.length !== 4 ||
    parts.some((part) => /^0x/i.test(part) || (part.length > 1 && part.startsWith("0"))) ||
    ipv4Octets(hostname) === undefined
  );
}

function isLoopbackOrWildcardHostname(value: string): boolean {
  const hostname = value
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (!hostname || hostname.includes("*") || hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }

  const ipv4 = ipv4Octets(hostname);
  if (ipv4) return ipv4[0] === 127 || ipv4.every((octet) => octet === 0);
  const words = ipv6Words(hostname);
  if (words) {
    if (words.every((word) => word === 0)) return true;
    if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
    const embeddedIpv4 = embeddedIpv4FromIpv6(words);
    return Boolean(
      embeddedIpv4 &&
        (embeddedIpv4[0] === 127 || embeddedIpv4.every((octet) => octet === 0)),
    );
  }
  return isAmbiguousIpv4Literal(hostname) || Boolean(
    hostname.includes(":"),
  );
}

type ParsedApiUrl = {
  apiBaseUrl: string;
  healthUrl: string;
  hostname: string;
  protocol: "http:" | "https:";
};

function parseApiUrl(value: string): ParsedApiUrl {
  const match = value.match(
    /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]+)(\/[^?#\\\s]*)?(?:\?[^#\s]*)?(?:#[^\s]*)?$/i,
  );
  if (!match) {
    throw new MiniProgramConfigurationError("apiBaseUrl 必须是有效的绝对 URL");
  }

  const protocol = `${match[1]!.toLowerCase()}:`;
  if (protocol !== "http:" && protocol !== "https:") {
    throw new MiniProgramConfigurationError("apiBaseUrl 只允许无凭据的 HTTP(S) URL");
  }

  const authority = match[2]!;
  if (authority.includes("@")) {
    throw new MiniProgramConfigurationError("apiBaseUrl 只允许无凭据的 HTTP(S) URL");
  }

  const ipv6 = authority.match(/^\[([0-9a-f:.]+)\](?::(\d+))?$/i);
  const hostAndPort = authority.match(/^([^:\s]+)(?::(\d+))?$/);
  if (!ipv6 && !hostAndPort) {
    throw new MiniProgramConfigurationError("apiBaseUrl 必须是有效的绝对 URL");
  }

  const rawHostname = ipv6 ? ipv6[1]! : hostAndPort![1]!;
  const port = ipv6 ? ipv6[2] : hostAndPort![2];
  const hostname = ipv6 ? `[${rawHostname.toLowerCase()}]` : rawHostname.toLowerCase();
  if (
    (ipv6 && !ipv6Words(rawHostname)) ||
    (!ipv6 && (!/^[a-z0-9.*-]+\.?$/i.test(rawHostname) || rawHostname.includes("..")))
  ) {
    throw new MiniProgramConfigurationError("apiBaseUrl 必须是有效的绝对 URL");
  }
  if (port && (!/^\d+$/.test(port) || Number(port) > 65_535)) {
    throw new MiniProgramConfigurationError("apiBaseUrl 必须是有效的绝对 URL");
  }

  const normalizedPort =
    (protocol === "https:" && port === "443") || (protocol === "http:" && port === "80")
      ? ""
      : port
        ? `:${port}`
        : "";
  const normalizedAuthority = `${hostname}${normalizedPort}`;
  const pathname = (match[3] || "").replace(/\/+$/, "");
  return {
    protocol,
    hostname,
    apiBaseUrl: `${protocol}//${normalizedAuthority}${pathname}`,
    healthUrl: `${protocol}//${normalizedAuthority}/health`,
  };
}

function requireApiUrl(
  value: unknown,
  mode: DeploymentMode,
  apiMode: ApiMode,
  accountEnvironment: AccountEnvironment,
): ParsedApiUrl {
  if (typeof value !== "string" || !value.trim()) {
    throw new MiniProgramConfigurationError("apiBaseUrl 必须显式设置");
  }

  const url = parseApiUrl(value.trim());
  const requiresRemoteHttps =
    apiMode === "real" &&
    (mode === "competition" || mode === "production" || accountEnvironment === "trial");
  if (requiresRemoteHttps) {
    const environmentName = mode === "demo" ? "demo 体验版" : mode;
    if (url.protocol !== "https:") {
      throw new MiniProgramConfigurationError(`${environmentName} 环境必须使用 HTTPS API`);
    }
    if (isLoopbackOrWildcardHostname(url.hostname)) {
      throw new MiniProgramConfigurationError(
        `${environmentName} 环境禁止使用本机、回环或通配 API 地址`,
      );
    }
  }
  return url;
}

const ENVIRONMENT_COPY: Record<
  DeploymentMode,
  Pick<MiniProgramEnvironment, "environmentLabel" | "environmentDetail">
> = {
  demo: {
    environmentLabel: "演示环境",
    environmentDetail: "公网 Qwen 演示服务 · 非生产",
  },
  test: {
    environmentLabel: "开发/测试环境",
    environmentDetail: "结果不可作为正式证据",
  },
  competition: {
    environmentLabel: "比赛取证环境",
    environmentDetail: "真实 AI · 非生产",
  },
  production: {
    environmentLabel: "生产环境",
    environmentDetail: "正式服务",
  },
};

export function resolveMiniProgramEnvironment(
  input: MiniProgramEnvironmentInput,
): MiniProgramEnvironment {
  const deploymentMode = requireEnum(input.deploymentMode, DEPLOYMENT_MODES, "deploymentMode");
  const apiMode = requireEnum(input.apiMode, API_MODES, "apiMode");
  const accountEnvironment = requireEnum(
    input.accountEnvironment,
    ACCOUNT_ENVIRONMENTS,
    "accountEnvironment",
  );
  const requestTimeoutMs = Number(input.requestTimeoutMs);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 60_000) {
    throw new MiniProgramConfigurationError("requestTimeoutMs 必须是 1000 到 60000 的整数");
  }

  if (apiMode === "mock" && deploymentMode !== "test") {
    throw new MiniProgramConfigurationError("mock API 只允许用于 test 环境");
  }
  if (deploymentMode === "demo" && accountEnvironment === "release") {
    throw new MiniProgramConfigurationError("demo 环境只允许微信 develop 或 trial 版本");
  }
  if (deploymentMode === "competition" && accountEnvironment !== "trial") {
    throw new MiniProgramConfigurationError("competition 环境必须使用微信 trial 版本");
  }
  if (deploymentMode === "production" && accountEnvironment !== "release") {
    throw new MiniProgramConfigurationError("production 环境必须使用微信 release 版本");
  }
  if (accountEnvironment === "release" && deploymentMode !== "production") {
    throw new MiniProgramConfigurationError("微信 release 版本只能运行 production 环境");
  }

  const appId = typeof input.appId === "string" ? input.appId.trim() : "";
  if (
    (deploymentMode === "competition" ||
      deploymentMode === "production" ||
      (deploymentMode === "demo" && accountEnvironment === "trial")) &&
    (!appId || appId.toLowerCase() === "touristappid")
  ) {
    throw new MiniProgramConfigurationError(
      `${deploymentMode === "demo" ? "demo 体验版" : deploymentMode} 环境必须配置真实微信 AppID`,
    );
  }

  const apiUrl = requireApiUrl(
    input.apiBaseUrl,
    deploymentMode,
    apiMode,
    accountEnvironment,
  );

  return {
    deploymentMode,
    apiMode,
    apiBaseUrl: apiUrl.apiBaseUrl,
    healthUrl: apiUrl.healthUrl,
    requestTimeoutMs,
    accountEnvironment,
    appId,
    demoEnabled: deploymentMode === "demo",
    storageNamespace: `warm_letter:${deploymentMode}`,
    ...ENVIRONMENT_COPY[deploymentMode],
  };
}

export function assertRemoteDeploymentMode(
  expected: DeploymentMode,
  actual: unknown,
): asserts actual is DeploymentMode {
  if (actual !== expected) {
    throw new MiniProgramConfigurationError(
      `小程序环境 ${expected} 与服务端环境 ${String(actual || "unknown")} 不一致`,
    );
  }
}

export function resolveDemoRequest(queryValue: unknown, demoEnabled: boolean): boolean {
  if (queryValue !== "1") return false;
  if (!demoEnabled) {
    throw new MiniProgramConfigurationError("当前环境禁止使用演示入口");
  }
  return true;
}
