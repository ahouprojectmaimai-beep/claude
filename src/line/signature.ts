/**
 * LINE Webhook の署名検証（X-Line-Signature）。
 * チャネルシークレットで本文の HMAC-SHA256 を計算し、Base64 で比較する。
 * 署名が合わないリクエストは LINE 以外からの偽装として必ず拒否する。
 */
export async function verifyLineSignature(body: string, signature: string | null, channelSecret: string): Promise<boolean> {
  if (!signature || !channelSecret) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(channelSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  const expected = btoa(String.fromCharCode(...mac));
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
