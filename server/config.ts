export type CookieSecureMode = 'auto' | 'true' | 'false';
export type TrustProxySetting = 'loopback' | boolean;

export interface ServerConfig {
  host: string;
  port: number;
  dbPath: string;
  tokenPepper: string;
  allowedOrigins: string[];
  cookieSecure: CookieSecureMode;
  trustProxy: TrustProxySetting;
  roomTtlDays: number;
  sseHeartbeatMs: number;
  logger: boolean;
}

function parseIntEnv(raw: string | undefined, fallback: number, min: number, max?: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    throw new Error(`Invalid numeric environment value: "${raw}"`);
  }
  return parsed;
}

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return [];
  const origins: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      origins.push(new URL(trimmed).origin);
    } catch {
      throw new Error(`Invalid ALLOWED_ORIGINS entry: "${trimmed}"`);
    }
  }
  return Array.from(new Set(origins));
}

function parseCookieSecure(raw: string | undefined): CookieSecureMode {
  if (!raw || raw.trim() === '') return 'auto';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'true' || normalized === 'false') {
    return normalized;
  }
  throw new Error(`Invalid COOKIE_SECURE value: "${raw}"`);
}

function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  if (!raw || raw.trim() === '') return 'loopback';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'loopback') return 'loopback';
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`Invalid TRUST_PROXY value: "${raw}"`);
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const envPepper = process.env.TOKEN_PEPPER?.trim();
  const isProd = process.env.NODE_ENV === 'production';

  if (overrides.tokenPepper === undefined && isProd && !envPepper) {
    throw new Error('TOKEN_PEPPER environment variable must be set when NODE_ENV=production');
  }

  return {
    host: overrides.host ?? (process.env.HOST?.trim() || '127.0.0.1'),
    port: overrides.port ?? parseIntEnv(process.env.PORT, 3000, 0, 65535),
    dbPath: overrides.dbPath ?? (process.env.DB_PATH?.trim() || './data/yueju.db'),
    tokenPepper:
      overrides.tokenPepper ?? (envPepper || 'dev-local-pepper-change-in-production'),
    allowedOrigins: overrides.allowedOrigins ?? parseAllowedOrigins(process.env.ALLOWED_ORIGINS),
    cookieSecure: overrides.cookieSecure ?? parseCookieSecure(process.env.COOKIE_SECURE),
    trustProxy: overrides.trustProxy ?? parseTrustProxy(process.env.TRUST_PROXY),
    roomTtlDays: overrides.roomTtlDays ?? parseIntEnv(process.env.ROOM_TTL_DAYS, 30, 1, 365),
    sseHeartbeatMs:
      overrides.sseHeartbeatMs ?? parseIntEnv(process.env.SSE_HEARTBEAT_MS, 25_000, 1_000),
    logger: overrides.logger ?? false,
  };
}
