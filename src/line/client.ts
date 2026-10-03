/**
 * LINE Messaging API クライアント（使う機能だけ）。
 * - アクセストークンは環境変数（Workers の Secret）から渡す。コードに書かない
 * - エラー時もレスポンス本文（個人情報を含みうる）はログに出さない
 */
export type LineMessage = { type: "text"; text: string; quoteToken?: string };

export class LineApiError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
  ) {
    super(`LINE API ${operation} failed: ${status}`);
    this.name = "LineApiError";
  }
}

export class LineClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(json = true): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}`, ...(json ? { "Content-Type": "application/json" } : {}) };
  }

  /** ユーザーが送った画像の本体を取得（LINE側では一定期間後に消えるため、受信後すぐに呼ぶ） */
  async getMessageContent(messageId: string): Promise<{ data: ArrayBuffer; contentType: string }> {
    const res = await this.fetchImpl(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
      headers: this.headers(false),
    });
    if (!res.ok) throw new LineApiError(res.status, "getMessageContent");
    return { data: await res.arrayBuffer(), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  /** 応答メッセージ（無料。replyToken は受信直後しか使えない） */
  async reply(replyToken: string, messages: LineMessage[]): Promise<void> {
    const res = await this.fetchImpl("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ replyToken, messages }),
    });
    if (!res.ok) throw new LineApiError(res.status, "reply");
  }

  /** プッシュメッセージ（送信先の人数分が通数にカウントされる）。retryKey で二重送信を防ぐ */
  async push(to: string, messages: LineMessage[], retryKey?: string): Promise<void> {
    const res = await this.fetchImpl("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { ...this.headers(), ...(retryKey ? { "X-Line-Retry-Key": retryKey } : {}) },
      body: JSON.stringify({ to, messages }),
    });
    // 409 = 同じ retryKey で送信済み（二重送信にならなかった）
    if (!res.ok && res.status !== 409) throw new LineApiError(res.status, "push");
  }
}
