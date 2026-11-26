type ConnectorName = "Aside" | "Chrome" | "Telegram" | "Discord" | "Gmail" | "Drive";
type ConnectorState = () => Promise<string>;
export type ConnectorProbes = Record<ConnectorName, ConnectorState>;

async function run(command: string, args: string[], timeout: number): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout });
    const stdout = new Response(proc.stdout).text();
    const code = await proc.exited;
    return code === 0 ? await stdout : undefined;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isConnectionError(error: unknown): boolean {
  return error instanceof TypeError || error instanceof DOMException;
}

function asideHealth(value: unknown): boolean | undefined {
  if (typeof value !== "object" || value === null || !("ready" in value) || typeof value.ready !== "boolean") return undefined;
  return value.ready;
}

async function secret(name: string): Promise<string | undefined> {
  const inherited = process.env[name]?.trim();
  if (inherited) return inherited;
  const value = await run("doppler", ["secrets", "get", name, "--project", "sanjai-ai", "--config", "prd", "--plain"], 5_000);
  return value?.trim() || undefined;
}

async function aside(): Promise<string> {
  try {
    const response = await fetch("http://127.0.0.1:21420/health", { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return "응답 오류";
    const ready = asideHealth(await response.json());
    return ready === undefined ? "응답 오류" : ready ? "정상" : "준비 안 됨";
  } catch (error) {
    if (error instanceof SyntaxError) return "응답 오류";
    if (isConnectionError(error)) return "연결 안 됨";
    throw error;
  }
}

async function chrome(): Promise<string> {
  if (process.platform !== "darwin") return "확인 불가";
  return await run("pgrep", ["-x", "Google Chrome"], 2_000) ? "실행 중" : "실행 안 됨";
}

async function telegram(): Promise<string> {
  const token = await secret("DORI_TELEGRAM_BOT_TOKEN");
  if (!token) return "인증 없음";
  try {
    const response = await fetch("https://api.telegram.org/bot" + token + "/getMe", { signal: AbortSignal.timeout(4_000) });
    return response.ok ? "정상" : response.status === 401 ? "인증 오류" : "연결 오류";
  } catch (error) {
    if (isConnectionError(error)) return "연결 오류";
    throw error;
  }
}

async function googleToken(): Promise<string | undefined> {
  const output = await run("gcloud", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], 3_000);
  if (!output) return undefined;
  const accounts = output.trim().split(/\r?\n/).filter(Boolean);
  const [active] = accounts;
  if (accounts.length !== 1 || !active || active.toLowerCase().startsWith("sosobaeklaw@")) return undefined;
  return (await run("gcloud", ["auth", "print-access-token", "--account=" + active], 3_000))?.trim() || undefined;
}

async function googleService(url: string, token: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(4_000),
    });
    return response.ok ? "정상" : response.status === 401 ? "인증 오류" : response.status === 403 ? "권한 없음" : "연결 오류";
  } catch (error) {
    if (isConnectionError(error)) return "연결 오류";
    throw error;
  }
}

async function discord(): Promise<string> {
  return await run("agent-discordbot", ["whoami"], 5_000) === undefined ? "연결 안 됨" : "정상";
}

function defaultProbes(): ConnectorProbes {
  let token: Promise<string | undefined> | undefined;
  const google = () => token ??= googleToken();
  return {
    Aside: aside,
    Chrome: chrome,
    Telegram: telegram,
    Discord: discord,
    Gmail: async () => {
      const value = await google();
      return value ? googleService("https://gmail.googleapis.com/gmail/v1/users/me/profile", value) : "API 인증 없음";
    },
    Drive: async () => {
      const value = await google();
      return value ? googleService("https://www.googleapis.com/drive/v3/about?fields=user(displayName)", value) : "API 인증 없음";
    },
  };
}

export async function connectorStatusLines(probes: ConnectorProbes = defaultProbes()): Promise<string[]> {
  const names: ConnectorName[] = ["Aside", "Chrome", "Telegram", "Discord", "Gmail", "Drive"];
  const results = await Promise.allSettled(names.map((name) => probes[name]()));
  const states = results.map((result) => result.status === "fulfilled" ? result.value : "검사 실패");
  return names.map((name, index) => "연결 " + name + ": " + states[index]);
}
