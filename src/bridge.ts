/**
 * Relays MCP between a client on stdio and the hosted Hyperodds server, which speaks Streamable
 * HTTP and keeps no session: every message from the client goes out as one POST. Hyperodds
 * answers with JSON; event streams are read too, since the protocol lets any server answer that way.
 */

type Id = string | number;

interface Message {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: { requestId?: unknown };
  result?: { protocolVersion?: unknown };
  error?: unknown;
}

export interface BridgeOptions {
  url: string;
  /** Names the server in errors: "Hyperodds", or the URL when it was set by hand. */
  label: string;
  write: (message: object) => void;
  /** Diagnostics, which the client shows in its server log; never the protocol channel. */
  log: (line: string) => void;
  userAgent: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

const isId = (v: unknown): v is Id => typeof v === "string" || typeof v === "number";
const isObject = (v: unknown): v is Message => typeof v === "object" && v !== null && !Array.isArray(v);

/** What a client may send: a request, a notification, or its answer to a server request. */
function kind(m: Message): "request" | "notification" | "answer" | null {
  if (m.jsonrpc !== "2.0") return null;
  if (typeof m.method === "string")
    return m.id === undefined ? "notification" : isId(m.id) ? "request" : null;
  if (m.method !== undefined || (m.result === undefined && m.error === undefined)) return null;
  return isId(m.id) || m.id === null ? "answer" : null;
}

function rpcError(id: Id | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export class Bridge {
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;
  private protocolVersion: string | null = null;
  private initializeId: Id | null = null;
  private readonly open = new Map<Id | symbol, AbortController>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly opts: BridgeOptions) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetch = opts.fetch ?? fetch;
  }

  /** Takes one line from the client. Requests run side by side; answers go out as they arrive. */
  receive(line: string): void {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.opts.write(rpcError(null, PARSE_ERROR, "Parse error: each line must be one JSON-RPC message."));
      return;
    }
    // The server takes one message per request, so a batch goes out member by member.
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    if (messages.length === 0)
      this.opts.write(rpcError(null, INVALID_REQUEST, "Invalid request: empty batch."));
    for (const msg of messages) {
      if (!isObject(msg) || kind(msg) === null) {
        const id = isObject(msg) && isId(msg.id) ? msg.id : null;
        this.opts.write(
          rpcError(
            id,
            INVALID_REQUEST,
            "Invalid request: not a JSON-RPC 2.0 request, notification or answer.",
          ),
        );
        continue;
      }
      if (msg.method === "notifications/cancelled" && isId(msg.params?.requestId)) {
        this.open.get(msg.params.requestId)?.abort("cancelled");
      }
      const task = this.forward(msg).finally(() => this.pending.delete(task));
      this.pending.add(task);
    }
  }

  /** Resolves once every message taken so far has been answered. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /** Drops every message still out; the client has stopped reading. */
  close(): void {
    for (const controller of this.open.values()) controller.abort("shutdown");
  }

  private async forward(msg: Message): Promise<void> {
    const replyTo = kind(msg) === "request" ? (msg.id as Id) : null;
    if (replyTo !== null && msg.method === "initialize") this.initializeId = replyTo;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), this.timeoutMs);
    const key = replyTo ?? Symbol();
    this.open.set(key, controller);
    let answered = false;
    let status = 0;
    try {
      const res = await this.fetch(this.opts.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(msg),
        signal: controller.signal,
      });
      status = res.status;
      const type = res.headers.get("content-type") ?? "";
      if (type.includes("text/event-stream") && res.body) {
        for await (const data of eventData(res.body)) {
          answered = this.deliver(JSON.parse(data) as Message, replyTo);
          if (answered) break;
        }
      } else if (type.includes("application/json")) {
        answered = this.deliver((await res.json()) as Message, replyTo);
      } else {
        await res.body?.cancel();
      }
    } catch (error) {
      const reason = controller.signal.reason;
      if (reason === "cancelled" || reason === "shutdown") return;
      this.report(replyTo, failureText(error, reason, this.opts.label, this.timeoutMs));
      return;
    } finally {
      clearTimeout(timer);
      this.open.delete(key);
    }
    if (replyTo !== null && !answered)
      this.report(replyTo, `${this.opts.label} replied HTTP ${status} with no JSON-RPC response.`);
  }

  private report(replyTo: Id | null, why: string): void {
    this.opts.log(why);
    if (replyTo !== null) this.opts.write(rpcError(replyTo, INTERNAL_ERROR, why));
  }

  /** Passes a server message to the client; true when it is the response to `replyTo`. */
  private deliver(body: Message, replyTo: Id | null): boolean {
    if (!isObject(body) || body.jsonrpc !== "2.0") return false;
    // Refusals made before the server has read the message (the burst limit, an oversized or
    // malformed body) carry no id.
    const refusal = body.error !== undefined && body.id === null;
    if (refusal && replyTo === null) {
      this.opts.log(`${this.opts.label} refused a message the client sent: ${JSON.stringify(body.error)}`);
      return false;
    }
    const out = refusal ? { ...body, id: replyTo } : body;
    const isResponse = out.method === undefined && replyTo !== null && out.id === replyTo;
    const version = out.result?.protocolVersion;
    if (isResponse && replyTo === this.initializeId && typeof version === "string")
      this.protocolVersion = version;
    this.opts.write(out);
    return isResponse;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": this.opts.userAgent,
      ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
    };
  }
}

function failureText(error: unknown, reason: unknown, label: string, timeoutMs: number): string {
  if (reason === "timeout") return `${label} did not answer within ${timeoutMs / 1000} seconds.`;
  if (error instanceof SyntaxError) return `${label} sent an answer that is not valid JSON.`;
  const code = (error as { cause?: { code?: unknown } })?.cause?.code;
  const detail = typeof code === "string" ? code : error instanceof Error ? error.message : String(error);
  return `Could not reach ${label} (${detail}).`;
}

async function* eventData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    // A CR at the end of a chunk may be half of a CRLF; wait for the next chunk to tell.
    const held = buffer.endsWith("\r") ? "\r" : "";
    const text = (held ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, "\n");
    const blocks = text.split("\n\n");
    buffer = blocks.pop()! + held;
    for (const block of blocks) {
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) yield data;
    }
  }
}
