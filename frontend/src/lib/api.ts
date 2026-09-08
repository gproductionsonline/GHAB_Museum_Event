export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000/api";

export type ApiErrorEnvelope = {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown[];
  };
};

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: string,
  ) {
    super(message);
  }
}

export type StoredUser = {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "STAFF" | "CHECKIN_OPERATOR";
};

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("ghab_token");
}

export function getUser(): StoredUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem("ghab_user");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredUser;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: StoredUser) {
  localStorage.setItem("ghab_token", token);
  localStorage.setItem("ghab_user", JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem("ghab_token");
  localStorage.removeItem("ghab_user");
  localStorage.removeItem("ghab_scanner_setup");
}

async function parseError(res: Response): Promise<never> {
  let message = `Request failed (${res.status})`;
  try {
    const body = (await res.json()) as ApiErrorEnvelope;
    message = body.error?.message ?? message;
  } catch {
    /* non-JSON error */
  }
  throw new ApiRequestError(res.status, message);
}

export async function api<T>(
  path: string,
  opts: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    formData?: FormData;
    token?: string | null;
  } = {},
): Promise<T> {
  const token = opts.token !== undefined ? opts.token : getToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.formData ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  if (!res.ok) return parseError(res);
  return (await res.json()) as T;
}

/** Download a token-protected file (CSV reports) without exposing it in a URL. */
export async function downloadFile(path: string, filename: string) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return parseError(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** SSE stream URL with token (EventSource cannot set headers). */
export function sseUrl(path: string, params: Record<string, string>): string {
  const token = getToken();
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}
