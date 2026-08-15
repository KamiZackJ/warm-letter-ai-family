export const DEPLOYMENT_MODES = ["demo", "test", "competition", "production"] as const;

export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

type RuntimeConfigInput = {
  appEnv?: string;
  apiBaseUrl?: string;
  demoEnabled?: string;
  expectedMode?: string;
};

export type WebRuntimeConfig = {
  deploymentMode: DeploymentMode;
  demoEnabled: boolean;
  apiBaseUrl: string;
  healthUrl: string;
  environmentLabel: string;
  environmentDetail: string;
};

export class RuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigurationError";
  }
}

function parseDeploymentMode(value: string | undefined, fieldName: string): DeploymentMode {
  const normalized = value?.trim();
  if (!DEPLOYMENT_MODES.includes(normalized as DeploymentMode)) {
    throw new RuntimeConfigurationError(
      `${fieldName} 必须显式设置为 ${DEPLOYMENT_MODES.join("、")}`,
    );
  }
  return normalized as DeploymentMode;
}

function parseBoolean(value: string | undefined, fieldName: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new RuntimeConfigurationError(`${fieldName} 必须显式设置为 true 或 false`);
}

function mappedIpv4FromIpv6(hostname: string): number[] | undefined {
  if (!hostname.startsWith("::ffff:")) return undefined;
  const groups = hostname.slice("::ffff:".length).split(":");
  if (groups.length !== 2) return undefined;
  const high = Number.parseInt(groups[0]!, 16);
  const low = Number.parseInt(groups[1]!, 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high > 0xffff || low > 0xffff) {
    return undefined;
  }
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isLoopbackOrWildcardHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (
    !normalized ||
    normalized.includes("*") ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost")
  ) {
    return true;
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) {
    const octets = normalized.split(".").map(Number);
    return octets[0] === 127 || octets.every((octet) => octet === 0);
  }
  if (normalized === "::" || normalized === "::1") return true;
  const mappedIpv4 = mappedIpv4FromIpv6(normalized);
  return Boolean(
    mappedIpv4 &&
      (mappedIpv4[0] === 127 || mappedIpv4.every((octet) => octet === 0)),
  );
}

function parseApiBaseUrl(value: string | undefined, mode: DeploymentMode): URL {
  const normalized = value?.trim();
  if (!normalized) {
    throw new RuntimeConfigurationError("VITE_API_BASE_URL 必须显式设置");
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new RuntimeConfigurationError("VITE_API_BASE_URL 必须是有效的绝对 URL");
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new RuntimeConfigurationError("VITE_API_BASE_URL 只允许无凭据的 HTTP(S) URL");
  }

  if ((mode === "competition" || mode === "production") && url.protocol !== "https:") {
    throw new RuntimeConfigurationError(`${mode} 环境必须使用 HTTPS API`);
  }
  if (
    (mode === "competition" || mode === "production") &&
    isLoopbackOrWildcardHostname(url.hostname)
  ) {
    throw new RuntimeConfigurationError(`${mode} 环境禁止使用本机或回环 API 地址`);
  }

  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

const ENVIRONMENT_COPY: Record<
  DeploymentMode,
  Pick<WebRuntimeConfig, "environmentLabel" | "environmentDetail">
> = {
  demo: {
    environmentLabel: "演示环境",
    environmentDetail: "模拟数据 / Fake AI",
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

export function resolveWebRuntimeConfig(input: RuntimeConfigInput): WebRuntimeConfig {
  const deploymentMode = parseDeploymentMode(input.appEnv, "VITE_APP_ENV");
  if (input.expectedMode) {
    const expectedMode = parseDeploymentMode(input.expectedMode, "Vite mode");
    if (expectedMode !== deploymentMode) {
      throw new RuntimeConfigurationError(
        `Vite mode ${expectedMode} 与 VITE_APP_ENV ${deploymentMode} 不一致`,
      );
    }
  }

  const demoEnabled = parseBoolean(input.demoEnabled, "VITE_DEMO_ENABLED");
  if (demoEnabled !== (deploymentMode === "demo")) {
    throw new RuntimeConfigurationError("只有 demo 环境可以启用内置演示数据");
  }

  const apiUrl = parseApiBaseUrl(input.apiBaseUrl, deploymentMode);
  const apiBaseUrl = apiUrl.toString().replace(/\/$/, "");
  const healthUrl = new URL("/health", apiUrl).toString();

  return {
    deploymentMode,
    demoEnabled,
    apiBaseUrl,
    healthUrl,
    ...ENVIRONMENT_COPY[deploymentMode],
  };
}

export function assertRemoteDeploymentMode(
  expected: DeploymentMode,
  actual: unknown,
): asserts actual is DeploymentMode {
  if (actual !== expected) {
    throw new RuntimeConfigurationError(
      `页面环境 ${expected} 与服务端环境 ${String(actual || "unknown")} 不一致`,
    );
  }
}
