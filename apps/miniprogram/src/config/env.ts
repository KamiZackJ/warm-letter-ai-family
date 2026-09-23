import {
  resolveMiniProgramEnvironment,
  MiniProgramConfigurationError,
  type AccountEnvironment,
  type MiniProgramEnvironmentInput,
} from "./runtime-environment";

const PRODUCTION_API_BASE_URL = "https://api.warmjiashu.xyz/v1";

type AccountInfo = {
  miniProgram?: {
    appId?: string;
    envVersion?: AccountEnvironment;
  };
};

function readAccountInfo(): AccountInfo | null {
  if (typeof wx === "undefined" || typeof wx.getAccountInfoSync !== "function") return null;
  try {
    return wx.getAccountInfoSync() as AccountInfo;
  } catch {
    throw new MiniProgramConfigurationError("暂时无法读取小程序环境，请重新打开暖笺");
  }
}

function buildEnvironmentInput(): MiniProgramEnvironmentInput {
  const accountInfo = readAccountInfo();
  if (!accountInfo?.miniProgram) {
    if (typeof wx !== "undefined" && typeof wx.getAccountInfoSync === "function") {
      throw new MiniProgramConfigurationError("暂时无法读取小程序环境，请重新打开暖笺");
    }
    return {
      deploymentMode: "test",
      apiMode: "mock",
      apiBaseUrl: "http://127.0.0.1:8787/v1",
      requestTimeoutMs: 12_000,
      accountEnvironment: "develop",
      appId: "unit-test",
    };
  }

  const accountEnvironment = accountInfo.miniProgram.envVersion || "develop";
  const appId = accountInfo.miniProgram.appId || "";
  return {
    deploymentMode: "production",
    apiMode: "real",
    apiBaseUrl: PRODUCTION_API_BASE_URL,
    requestTimeoutMs: 12_000,
    accountEnvironment,
    appId,
  };
}

export const environment = resolveMiniProgramEnvironment(buildEnvironmentInput());

export const environmentView = {
  environmentMode: environment.deploymentMode,
  environmentLabel: environment.environmentLabel,
  environmentDetail: environment.environmentDetail,
  demoEnabled: environment.demoEnabled,
} as const;

export function storageKey(name: string): string {
  return `${environment.storageNamespace}:${name}`;
}
