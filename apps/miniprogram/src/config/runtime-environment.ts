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

function mappedIpv4FromIpv6(hostname: string): number[] | undefined {
  if (!hostname.startsWith("::ffff:")) return undefined;
  const suffix = hostname.slice("::ffff:".length);
  const dottedIpv4 = ipv4Octets(suffix);
  if (dottedIpv4) return dottedIpv4;

  const groups = suffix.split(":");
  if (groups.length !== 2) return undefined;
  const high = Number.parseInt(groups[0]!, 16);
  const low = Number.parseInt(groups[1]!, 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high > 0xffff || low > 0xffff) {
    return undefined;
  }
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
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
  if (hostname === "::" || hostname === "::1") return true;

  const mappedIpv4 = mappedIpv4FromIpv6(hostname);
  return Boolean(
    mappedIpv4 && (mappedIpv4[0] === 127 || mappedIpv4.every((octet) => octet === 0)),
  );
}

function requireApiUrl(value: unknown, mode: DeploymentMode, apiMode: ApiMode): URL {
  if (typeof value !== "string" || !value.trim()) {
    throw new MiniProgramConfigurationError("apiBaseUrl 必须显式设置");
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new MiniProgramConfigurationError("apiBaseUrl 必须是有效的绝对 URL");
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new MiniProgramConfigurationError("apiBaseUrl 只允许无凭据的 HTTP(S) URL");
  }
  if (apiMode === "real" && (mode === "competition" || mode === "production")) {
    if (url.protocol !== "https:") {
      throw new MiniProgramConfigurationError(`${mode} 环境必须使用 HTTPS API`);
    }
    if (isLoopbackOrWildcardHostname(url.hostname)) {
      throw new MiniProgramConfigurationError(`${mode} 环境禁止使用本机、回环或通配 API 地址`);
    }
  }

  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

const ENVIRONMENT_COPY: Record<
  DeploymentMode,
  Pick<MiniProgramEnvironment, "environmentLabel" | "environmentDetail">
> = {
  demo: {
    environmentLabel: "演示环境",
    environmentDetail: "本地服务 / Fake AI",
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
  if (deploymentMode === "demo" && accountEnvironment !== "develop") {
    throw new MiniProgramConfigurationError("demo 环境只允许微信 develop 版本");
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
    (deploymentMode === "competition" || deploymentMode === "production") &&
    (!appId || appId.toLowerCase() === "touristappid")
  ) {
    throw new MiniProgramConfigurationError(`${deploymentMode} 环境必须配置真实微信 AppID`);
  }

  const apiUrl = requireApiUrl(input.apiBaseUrl, deploymentMode, apiMode);
  const apiBaseUrl = apiUrl.toString().replace(/\/$/, "");

  return {
    deploymentMode,
    apiMode,
    apiBaseUrl,
    healthUrl: new URL("/health", apiUrl).toString(),
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
