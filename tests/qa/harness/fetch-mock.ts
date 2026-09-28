/**
 * fetch-mock — Programmable fetch mock for translation engine tests.
 *
 * Lets a test script exact request/response sequences so engine behaviour can be
 * asserted deterministically: which URL, method, headers, body, in what order,
 * and what the translator does on success / HTTP error / network throw / timeout.
 *
 * Usage:
 *   const fm = createFetchMock();
 *   fm.install();
 *   fm.route("https://translation.googleapis.com/**")
 *     .reply(200, { data: { translations: [{ translatedText: "你好" }] } });
 *   fm.route("https://www.bing.com/**")
 *     .times(2)
 *     .replySequence([
 *       { status: 200, body: '<html>IG:"ABCD" params_AbusePreventionHelper=[1,"tok",3600000]</html>' },
 *       { status: 200, body: [{ translations: [{ text: "你好" }] }] },
 *     ]);
 *   // ... call the code under test ...
 *   expect(fm.calls[0].url).toContain("googleapis.com");
 *   expect(fm.callsFor(/bing\.com/)).toHaveLength(2);
 *   fm.uninstall();
 */

export type RouteBody =
  | string
  | Record<string, unknown>
  | Array<unknown>
  | ((url: string, init: RequestInit) => unknown);

export interface ReplySpec {
  status?: number;
  body?: RouteBody;
  /** Reject the fetch call (network-level failure). */
  throwError?: Error;
  /** Delay in ms before replying (tests abort/timeout paths with fake time). */
  delayMs?: number;
}

interface Route {
  pattern: RegExp;
  replies: ReplySpec[];
  /** Max times the route may match (default Infinity). */
  limit: number;
  hits: number;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function globToRegExp(pattern: string): RegExp {
  // `?` must be escaped too (regex-special, and common in API URLs); `*` is
  // handled below via placeholders so the two star rules can't eat each other's
  // output (`**`→`.*` then `*`→`[^/]*` would otherwise rewrite the `*` inside
  // `.*` and silently demote ** to a single-segment match).
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp("^" + escaped + "$");
}

class RouteBuilder {
  private route: Route;
  private owner: FetchMock;

  constructor(route: Route, owner: FetchMock) {
    this.route = route;
    this.owner = owner;
  }

  reply(status: number, body?: RouteBody): FetchMock {
    this.route.replies.push({ status, body });
    return this.owner;
  }

  once(status: number, body?: RouteBody): FetchMock {
    this.route.replies.push({ status, body });
    this.route.limit = Math.min(this.route.limit, this.route.hits + 1);
    return this.owner;
  }

  times(n: number): RouteBuilder {
    this.route.limit = n;
    return this;
  }

  replySequence(replies: Array<ReplySpec | number>): FetchMock {
    for (const r of replies) {
      this.route.replies.push(typeof r === "number" ? { status: r } : r);
    }
    return this.owner;
  }

  throws(error: Error): FetchMock {
    this.route.replies.push({ throwError: error });
    return this.owner;
  }
}

export class FetchMock {
  readonly calls: RecordedCall[] = [];
  private routes: Route[] = [];
  private savedFetch: unknown;

  /** Register a route. Pattern is a URL glob (** = any chars, * = within-segment). */
  route(pattern: string): RouteBuilder {
    const r: Route = { pattern: globToRegExp(pattern), replies: [], limit: Infinity, hits: 0 };
    this.routes.push(r);
    return new RouteBuilder(r, this);
  }

  private async respondFor(url: string, init: RequestInit): Promise<Response> {
    const route = this.routes.find((r) => r.pattern.test(url) && r.hits < r.limit);
    if (!route) {
      throw new Error(
        `fetch-mock: no route matched ${url} (routes: ${this.routes.map((r) => String(r.pattern)).join(", ") || "none"})`,
      );
    }
    route.hits += 1;
    const spec = route.replies[Math.min(route.hits - 1, route.replies.length - 1)] ?? {
      status: 200,
    };
    if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
    if (spec.throwError) throw spec.throwError;
    let body: BodyInit | undefined;
    if (spec.body !== undefined) {
      body =
        typeof spec.body === "function"
          ? JSON.stringify((spec.body as (u: string, i: RequestInit) => unknown)(url, init))
          : typeof spec.body === "string"
            ? spec.body
            : JSON.stringify(spec.body);
    }
    const status = spec.status ?? 200;
    if (status >= 200 && status < 300) {
      return new Response(body ?? null, { status });
    }
    const resp = new Response(body ?? "", { status });
    // Mirror the real fetch: text() is what the engines call on failures.
    return resp;
  }

  private makeFetch(): typeof fetch {
    const self = this;
    return async function fetchMock(
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ): Promise<Response> {
      const url = typeof input === "string" ? input : (input as any).url ?? String(input);
      const headers: Record<string, string> = {};
      const h = init?.headers;
      if (h) {
        if (h instanceof Headers) h.forEach((v, k) => (headers[k] = v));
        else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
        else Object.assign(headers, h);
      }
      self.calls.push({
        url,
        method: init?.method ?? "GET",
        headers,
        body: init?.body !== undefined ? String(init.body) : null,
      });
      return self.respondFor(url, init ?? {});
    } as typeof fetch;
  }

  install(): void {
    this.savedFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = this.makeFetch();
  }

  uninstall(): void {
    if (this.savedFetch === undefined) delete (globalThis as any).fetch;
    else (globalThis as any).fetch = this.savedFetch;
  }

  /** Calls whose URL matches. */
  callsFor(pattern: string | RegExp): RecordedCall[] {
    const re = typeof pattern === "string" ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : pattern;
    return this.calls.filter((c) => re.test(c.url));
  }

  /** Parsed JSON body of a recorded call (for request-shape assertions). */
  jsonBody(call: RecordedCall): any {
    return JSON.parse(call.body ?? "null");
  }

  /** Form body of a recorded call as a plain object. */
  formBody(call: RecordedCall): Record<string, string> {
    return Object.fromEntries(new URLSearchParams(call.body ?? ""));
  }

  reset(): void {
    this.calls.length = 0;
    this.routes = [];
  }
}

export function createFetchMock(): FetchMock {
  return new FetchMock();
}
