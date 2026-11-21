/**
 * Node.js reads the proxy variables once, at startup, and only with NODE_USE_ENV_PROXY=1 or
 * --use-env-proxy (22.21 and later, 24.5 and later). fetch then follows undici's rules, which this
 * mirrors so errors can say what happened: a lowercase variable that is set, even to "", wins over
 * the uppercase one.
 */

type Env = Record<string, string | undefined>;

export interface ProxyNote {
  /** Added to errors when the server cannot be reached. */
  text: string;
  /** True when a proxy is set but Node.js does not use it. */
  ignored: boolean;
}

function supported(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major >= 25 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
}

/** NO_PROXY: hosts split by commas or spaces, each with an optional port; ".x" and "*x" match suffixes. */
function bypassed(target: URL, noProxy: string): boolean {
  const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
  return noProxy
    .split(/[,\s]/)
    .filter(Boolean)
    .some((entry) => {
      const [, host = entry, only] = /^(.+):(\d+)$/.exec(entry) ?? [];
      if (only && Number(only) !== port) return false;
      const name = host.toLowerCase();
      return /^[.*]/.test(name)
        ? target.hostname.endsWith(name.replace(/^\*/, ""))
        : target.hostname === name;
    });
}

/** `flags` are the Node.js options in effect: process.execArgv and those in NODE_OPTIONS. */
export function proxyNote(target: URL, env: Env, version: string, flags: string[]): ProxyNote | undefined {
  const scheme = target.protocol === "https:" ? "https" : "http";
  const name = [`${scheme}_proxy`, `${scheme.toUpperCase()}_PROXY`].find((n) => env[n] !== undefined);
  const value = name && env[name];
  if (!name || !value) return;
  if (env.NODE_USE_ENV_PROXY !== "1" && !flags.includes("--use-env-proxy"))
    return {
      text: `${name} is set, but Node.js ignores it unless NODE_USE_ENV_PROXY=1 is set as well.`,
      ignored: true,
    };
  if (!supported(version))
    return {
      text: `${name} is set, but Node.js ${version} cannot use it: proxy support needs 22.21, 24.5 or later.`,
      ignored: true,
    };
  if (bypassed(target, env.no_proxy ?? env.NO_PROXY ?? "")) return;
  if (!URL.canParse(value)) return { text: `${name} is not a URL.`, ignored: true };
  const proxy = new URL(value);
  return {
    text: `Requests go through the proxy ${proxy.protocol}//${proxy.host} from ${name}.`,
    ignored: false,
  };
}
