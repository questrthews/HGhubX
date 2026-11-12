import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
export function publicIP(ip) {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Restrict IPv6 to ordinary global unicast; exclude transition/documentation ranges.
  return (
    isIP(ip) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(ip) &&
    !/^200[12]:|^3fff:/i.test(ip) &&
    !(
      ip.toLowerCase().startsWith("2001:") &&
      (parseInt(ip.split(":")[1] || "0", 16) < 0x200 ||
        parseInt(ip.split(":")[1], 16) === 0xdb8)
    )
  );
}
export async function target(raw) {
  const u = new URL(raw);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443")
  )
    throw Error("Only public HTTPS media on port 443 is supported");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => !publicIP(a.address)))
    throw Error("Local or reserved network target blocked");
  return { u, addresses };
}
export async function request(
  raw,
  {
    method = "GET",
    body,
    headers = {},
    signal,
    max = 64 * 1024 * 1024,
    onChunk,
  } = {},
  hops = 0,
) {
  if (hops > 5) throw Error("Too many redirects");
  const { u, addresses } = await target(raw);
  return new Promise((resolve, reject) => {
    const req = https.request(
      u,
      {
        method,
        signal,
        headers: { "User-Agent": "HGhubX-English/1.0", ...headers },
        lookup: (_host, opts, cb) =>
          opts.all
            ? cb(null, addresses)
            : cb(null, addresses[0].address, addresses[0].family),
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          if (method !== "GET" || !res.headers.location)
            return reject(Error("Redirect blocked"));
          request(
            new URL(res.headers.location, u).href,
            { method, headers, signal, max, onChunk },
            hops + 1,
          ).then(resolve, reject);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(Error(`Upstream HTTP ${res.statusCode}`));
          return;
        }
        let size = 0;
        const chunks = [];
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > max) {
            res.destroy(Error("Response exceeds size limit"));
            return;
          }
          try {
            onChunk?.(chunk);
            chunks.push(chunk);
          } catch (e) {
            res.destroy(e);
          }
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            bytes: Buffer.concat(chunks),
            type: res.headers["content-type"] || "",
            url: u.href,
          }),
        );
      },
    );
    req.setTimeout(30000, () => req.destroy(Error("Request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}
