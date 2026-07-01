import { ApiError } from "./types.ts";

export interface PostJsonOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

// Transient HTTP classes worth retrying (plus any 5xx).
const RETRYABLE = new Set([408, 409, 429]);

function extractError(body: string): string | undefined {
  try {
    const j = JSON.parse(body) as { error?: { message?: string } };
    return j?.error?.message;
  } catch {
    return undefined;
  }
}

// POST a JSON body and parse a JSON response, with bounded retry on 429/408/409/5xx
// (honoring retry-after). Non-2xx becomes an ApiError carrying status + the API's
// error.message. fetch and sleep are injectable so this is testable with no network.
// Shared by both the Anthropic and Gemini transports.
export async function postJson<T>(opts: PostJsonOptions): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoff = (attempt: number) => sleep(500 * Math.pow(2, attempt));

  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetchImpl(opts.url, {
        method: "POST",
        headers: opts.headers,
        body: JSON.stringify(opts.body),
      });
    } catch (err) {
      if (attempt < maxRetries) {
        await backoff(attempt);
        attempt++;
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new ApiError(0, `network error: ${message}`);
    }

    if (res.ok) {
      return (await res.json()) as T;
    }

    const status = res.status;
    const bodyText = await res.text().catch(() => "");
    const message = extractError(bodyText) ?? `HTTP ${status}`;
    const retryable = RETRYABLE.has(status) || status >= 500;
    if (retryable && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        await sleep(retryAfter * 1000);
      } else {
        await backoff(attempt);
      }
      attempt++;
      continue;
    }
    throw new ApiError(status, message);
  }
}
