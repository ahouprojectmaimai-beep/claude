// 秘密情報の暗号化(AES-GCM)・署名(HMAC)・トークン
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64u = {
  enc(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(s: string): Uint8Array {
    const p = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const bin = atob(p);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plain: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(plain));
  return `v1.${b64u.enc(iv)}.${b64u.enc(ct)}`;
}

export async function decryptSecret(packed: string, secret: string): Promise<string> {
  const [v, iv, ct] = packed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("bad ciphertext");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64u.dec(iv) as BufferSource }, await aesKey(secret), b64u.dec(ct) as BufferSource);
  return dec.decode(pt);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** payload を署名付き文字列にする（Cookie・OAuth state 用） */
export async function signPayload(payload: object, secret: string): Promise<string> {
  const body = b64u.enc(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${b64u.enc(sig)}`;
}

export async function verifyPayload<T>(token: string | undefined, secret: string): Promise<T | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64u.dec(sig) as BufferSource, enc.encode(body));
  if (!ok) return null;
  try {
    return JSON.parse(dec.decode(b64u.dec(body))) as T;
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return b64u.enc(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** 予約管理ID: UUIDのハイフン抜き32桁hex（Googleイベントidの文字種 a-v0-9 に収まる） */
export function newBookingId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
