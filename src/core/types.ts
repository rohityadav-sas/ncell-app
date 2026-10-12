export type JsonObject = Record<string, unknown>;

export interface Account {
  msisdn: string;
  accessToken: string;
  refreshToken?: string;
  authenticatedAt: string;
  tokenSavedAt?: string;
  accessTokenExpiresAt?: string;
}

export interface SavedAccount {
  deviceId: string;
  account: Account;
}

export interface Session {
  deviceId: string;
  pendingMsisdn?: string;
  account?: Account;
  otherAccounts: SavedAccount[];
}

export interface SessionStore {
  load(): Promise<Session | undefined>;
  save(session: Session): Promise<void>;
  clear(): Promise<void>;
  withLock?<T>(operation: () => Promise<T>): Promise<T>;
}

export interface AccountOptions {
  store?: SessionStore;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface AccountStatus {
  account?: string;
  authenticatedAt?: string;
  tokenSavedAt?: string;
  accessTokenExpiresAt?: string;
}

export interface AccountSummary {
  msisdn: string;
  active: boolean;
}
