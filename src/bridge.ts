/**
 * Relays MCP between a client on stdio and the hosted Hyperodds server, which speaks Streamable
 * HTTP and keeps no session: every message from the client goes out as one POST. Hyperodds
 * answers with JSON; event streams are read too, since the protocol lets any server answer that way.
 *
 * With a forecaster key, the bridge also signs forecasts: it turns an odds_forecast call into a
 * draft for this computer's forecaster, checks the draft and records it signed.
 */
import { checkDraft, digest, type Signable } from "./forecast.js";
import { type KeySource, openKey, type Signer } from "./key.js";

type Id = string | number;
type Json = Record<string, unknown>;

interface Message {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: { requestId?: unknown; name?: unknown; arguments?: unknown };
  result?: {
    protocolVersion?: unknown;
    tools?: unknown;
    content?: unknown;
    structuredContent?: unknown;
    isError?: unknown;
  };
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
  /** The forecaster key. Without it, forecasts pass through unsigned, for a sign link. */
  keys?: KeySource;
  now?: () => number;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

const isId = (v: unknown): v is Id => typeof v === "string" || typeof v === "number";
const isObject = (v: unknown): v is Message => typeof v === "object" && v !== null && !Array.isArray(v);
const isRecord = (v: unknown): v is Json => isObject(v);

/** What the bridge adds to the forecast tools' descriptions when it signs. */
const NOTES: Record<string, string> = {
  odds_forecast:
    "This bridge signs on this computer: send forecasts alone and the answer is the recorded forecasts, signed by this computer's forecaster. Name a forecaster only to get a sign link for another wallet.",
  odds_forecast_record: "Leave out address to read this computer's forecaster.",
};

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

function toolError(id: Id, text: string): Message {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } };
}

const withArguments = (msg: Message, args: Json): Message => ({
  ...msg,
  params: { ...msg.params, arguments: args },
});

/** A message the bridge put together itself, to be reported as is. */
class Failure extends Error {}

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
    try {
      const response =
        replyTo === null
          ? await this.send(msg, null, controller.signal)
          : await this.answer(msg, replyTo, controller.signal);
      if (response) this.opts.write(response);
    } catch (error) {
      const reason = controller.signal.reason;
      if (reason === "cancelled" || reason === "shutdown") return;
      const why =
        error instanceof Failure
          ? error.message
          : failureText(error, reason, this.opts.label, this.timeoutMs);
      this.opts.log(why);
      if (replyTo !== null) this.opts.write(rpcError(replyTo, INTERNAL_ERROR, why));
    } finally {
      clearTimeout(timer);
      this.open.delete(key);
    }
  }

  /** The response to a request: the server's, or for forecasts, the one the bridge gets by signing. */
  private async answer(msg: Message, id: Id, signal: AbortSignal): Promise<Message | null> {
    const keys = this.opts.keys;
    if (keys && msg.method === "tools/call") {
      const { name, arguments: args } = msg.params ?? {};
      if (
        name === "odds_forecast" &&
        isRecord(args) &&
        args.signed === undefined &&
        Array.isArray(args.forecasts)
      )
        return this.forecast(msg, id, args, keys, signal);
      if (
        name === "odds_forecast_record" &&
        (args === undefined || (isRecord(args) && args.address === undefined))
      )
        return this.record(msg, id, args ?? {}, keys, signal);
    }
    const response = await this.send(msg, id, signal);
    if (keys && msg.method === "tools/list" && response) annotate(response);
    return response;
  }

  /**
   * Drafts the forecasts asked for under this computer's forecaster, checks that the draft's typed
   * data is exactly those forecasts in the contract's terms, signs it and records it. A forecaster
   * named by the client that is not this computer's gets the hosted flow: a sign link for that wallet.
   */
  private async forecast(msg: Message, id: Id, args: Json, keys: KeySource, signal: AbortSignal) {
    let signer: Signer | null;
    try {
      signer = openKey(keys, args.forecaster === undefined);
    } catch (error) {
      return this.refuse(id, (error as Error).message);
    }
    if (
      !signer ||
      (args.forecaster !== undefined && String(args.forecaster).toLowerCase() !== signer.address)
    )
      return this.send(msg, id, signal);

    const draft = await this.send(withArguments(msg, { ...args, forecaster: signer.address }), id, signal);
    const body = draft?.result?.structuredContent;
    if (!draft?.result || draft.result.isError || !isRecord(body) || body.status !== "draft") return draft;
    let signable: Signable;
    try {
      signable = checkDraft(body.typedData, {
        forecaster: signer.address,
        entries: args.forecasts,
        nowMs: (this.opts.now ?? Date.now)(),
      });
    } catch (error) {
      return this.refuse(
        id,
        `${this.opts.label} sent a draft that differs from the forecasts asked for, so nothing was signed: ${(error as Error).message}.`,
      );
    }
    const signed = {
      type: signable.type,
      message: (body.typedData as Json).message,
      signature: signer.sign(digest(signable)),
      ...(typeof body.draft === "string" ? { draft: body.draft } : {}),
    };
    const recorded = await this.send(withArguments(msg, { signed }), id, signal);
    const content = recorded?.result?.content;
    if (!recorded?.result || recorded.result.isError || !Array.isArray(content)) return recorded;
    content.push({
      type: "text",
      text: `Signed on this computer by forecaster ${signer.address}. Its public record is ${recordUrl(body.url, signer.address)}, where each forecast appears after its market's cutoff.`,
    });
    return recorded;
  }

  /** odds_forecast_record without an address reads this computer's forecaster. */
  private async record(msg: Message, id: Id, args: Json, keys: KeySource, signal: AbortSignal) {
    let signer: Signer | null;
    try {
      signer = openKey(keys, false);
    } catch (error) {
      return this.refuse(id, (error as Error).message);
    }
    if (!signer)
      return toolError(
        id,
        "No forecast has been signed on this computer yet, so it has no forecaster. Name an address to read its record.",
      );
    return this.send(withArguments(msg, { ...args, address: signer.address }), id, signal);
  }

  private refuse(id: Id, why: string): Message {
    this.opts.log(why);
    return toolError(id, why);
  }

  /**
   * Posts one message. Resolves to the server's response to it, once whatever the server sent
   * before that has gone on to the client; to null for a message that expects no response.
   */
  private async send(msg: Message, replyTo: Id | null, signal: AbortSignal): Promise<Message | null> {
    const res = await this.fetch(this.opts.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(msg),
      signal,
    });
    const type = res.headers.get("content-type") ?? "";
    let taken: Message | null | undefined;
    if (type.includes("text/event-stream") && res.body) {
      for await (const data of eventData(res.body)) {
        taken = this.take(JSON.parse(data) as Message, replyTo);
        if (taken !== undefined) break;
      }
    } else if (type.includes("application/json")) {
      taken = this.take((await res.json()) as Message, replyTo);
    } else {
      await res.body?.cancel();
    }
    if (taken !== undefined) return taken;
    if (replyTo !== null)
      throw new Failure(`${this.opts.label} replied HTTP ${res.status} with no JSON-RPC response.`);
    if (res.status >= 300)
      this.opts.log(`${this.opts.label} replied HTTP ${res.status} to a message the client sent.`);
    return null;
  }

  /**
   * Takes one message from the server. The response to `replyTo` is returned; a refusal of a
   * message that expects no response settles it as null; anything else goes on to the client and
   * leaves it unsettled (undefined).
   */
  private take(body: Message, replyTo: Id | null): Message | null | undefined {
    if (!isObject(body) || body.jsonrpc !== "2.0") return undefined;
    // Refusals made before the server has read the message (the burst limit, an oversized or
    // malformed body) carry no id.
    const refusal = body.error !== undefined && body.id === null;
    if (refusal && replyTo === null) {
      this.opts.log(`${this.opts.label} refused a message the client sent: ${JSON.stringify(body.error)}`);
      return null;
    }
    const out = refusal ? { ...body, id: replyTo } : body;
    if (out.method !== undefined || replyTo === null || out.id !== replyTo) {
      this.opts.write(out);
      return undefined;
    }
    const version = out.result?.protocolVersion;
    if (replyTo === this.initializeId && typeof version === "string") this.protocolVersion = version;
    return out;
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

/** Tells the client's model what signing on this computer changes about the forecast tools. */
function annotate(response: Message): void {
  const tools = response.result?.tools;
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== "string") continue;
    const note = NOTES[tool.name];
    if (!note) continue;
    tool.description = typeof tool.description === "string" ? `${tool.description} ${note}` : note;
    const schema = tool.inputSchema;
    if (tool.name === "odds_forecast_record" && isRecord(schema) && Array.isArray(schema.required))
      schema.required = schema.required.filter((field) => field !== "address");
  }
}

/** The forecaster's page on the site that made the draft's sign link, usehyperodds.com if none. */
function recordUrl(draftUrl: unknown, address: string): string {
  try {
    const url = new URL(`/forecasts/${address}`, String(draftUrl));
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {}
  return `https://usehyperodds.com/forecasts/${address}`;
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
