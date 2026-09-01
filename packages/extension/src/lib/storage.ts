export interface LocalSettings {
  relayUrl: string | null;
  token: string | null;
  /** Extra origins (match patterns) where the tools activate; localhost is always on. */
  allowlist: string[];
  /** Origins where mutation tools are disabled (dev origins default to allowed). */
  mutationDeniedOrigins: string[];
  pendingPair: { relayUrl: string; token: string } | null;
}

const DEFAULTS: LocalSettings = { relayUrl: null, token: null, allowlist: [], mutationDeniedOrigins: [], pendingPair: null };

export async function getSettings(): Promise<LocalSettings> {
  const raw = (await chrome.storage.local.get('settings')) as { settings?: Partial<LocalSettings> };
  return { ...DEFAULTS, ...(raw.settings ?? {}) };
}

export async function updateSettings(patch: Partial<LocalSettings>): Promise<LocalSettings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export interface SessionState {
  resumeId: string;
}

export async function getSession(): Promise<SessionState> {
  const raw = (await chrome.storage.session.get('session')) as { session?: SessionState };
  if (raw.session) return raw.session;
  const s: SessionState = { resumeId: crypto.randomUUID() };
  await chrome.storage.session.set({ session: s });
  return s;
}
