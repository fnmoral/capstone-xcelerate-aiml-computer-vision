import { env } from "../../config/env";

export class ApiError extends Error {
  status: number;
  code?: string; // e.g. email_not_verified, forbidden, unauthenticated
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Fired on window when an API call answers "sign in to continue". */
export const UNAUTHORIZED_EVENT = "fallguard:unauthorized";

/** A request with no answer after this long fails, so a hung backend can't freeze a page's polling. */
const TIMEOUT_MS = 15000;

/** Thin typed REST wrapper for the core backend API. Errors carry the backend's message. */
export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${env.apiBaseUrl}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
      headers: { "Content-Type": "application/json", ...init.headers },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError")
      throw new ApiError(0, "The backend took too long to answer. Try again.");
    throw new ApiError(0, "Cannot reach the backend. Is the stack running?");
  }
  if (!res.ok) {
    const text = await res.text();
    let message = text || res.statusText;
    let code: string | undefined;
    try {
      const body = JSON.parse(text);
      message = body.error ?? message;
      code = body.code;
    } catch {
      /* not JSON */
    }
    // The session ended (signed out elsewhere, removed from the organization): the auth
    // provider sends the user back to the sign-in page.
    if (res.status === 401 && code === "unauthenticated")
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(res.status, message, code);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** URL of a backend resource for links and downloads (CSV exports). */
export function apiUrl(path: string): string {
  return `${env.apiBaseUrl}${path}`;
}
/** URL of a stream-hub resource: live video WebSocket, fall clips, snapshots. */
export function streamHubUrl(path: string): string {
  return `${env.streamBaseUrl}${path}`;
}
