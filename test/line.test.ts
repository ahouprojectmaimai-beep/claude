import { beforeEach, describe, expect, it } from "vitest";
import { verifyLineSignature } from "../src/line/signature";
import { parseWebhook, type WebhookEvent } from "../src/line/events";
import { handleEvent, type HandlerDeps } from "../src/line/handler";
import { InMemoryLineRepo } from "../src/line/repo";
import { detectStoreClaim } from "../src/line/storeClaim";
import { LineClient } from "../src/line/client";
import worker from "../src/worker/index";
import { testConfig } from "./helpers";

const cfg = testConfig();
const GROUP = "Cgroup0001";
const T0 = Date.parse("2026-10-03T08:00:00Z");

async function sign(body: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return btoa(String.fromCharCode(...mac));
}

let seq = 0;
function textEv(text: string, at = T0, userId = "Ustaff1", groupId = GROUP): WebhookEvent {
  seq++;
  return { type: "message", webhookEventId: `we${seq}`, timestamp: at, replyToken: `rt${seq}`, source: { type: "group", groupId, userId }, message: { id: `m${seq}`, type: "text", text, quoteToken: `q${seq}` } };
}
function imageEv(at = T0, userId = "Ustaff1", groupId = GROUP): WebhookEvent {
  seq++;
  return { type: "message", webhookEventId: `we${seq}`, timestamp: at, replyToken: `rt${seq}`, source: { type: "group", groupId, userId }, message: { id: `m${seq}`, type: "image", quoteToken: `q${seq}` } };
}

function makeDeps(over: Partial<HandlerDeps> = {}) {
  const repo = new InMemoryLineRepo();
  const replies: { token: string; text: string }[] = [];
  const stored = new Map<string, number>();
  const contents = new Map<string, string>();
  const deps: HandlerDeps = {
    cfg,
    repo,
    line: {
      async getMessageContent(id) {
        const bytes = new TextEncoder().encode(contents.get(id) ?? `image-bytes-${id}`);
        return { data: bytes.buffer as ArrayBuffer, contentType: "image/jpeg" };
      },
      async reply(token, messages) {
        for (const m of messages) replies.push({ token, text: m.text });
      },
    },
    images: { put: async (key, data) => void stored.set(key, data.byteLength) },
    postGroupId: GROUP,
    pairWindowMs: 10 * 60 * 1000,
    debugAck: false,
    ...over,
  };
  return { deps, repo, replies, stored, contents };
}

describe("署名検証", () => {
  it("正しい署名だけ通す", async () => {
    const body = '{"destination":"x","events":[]}';
    expect(await verifyLineSignature(body, await sign(body, "secret"), "secret")).toBe(true);
    expect(await verifyLineSignature(body, await sign(body, "other"), "secret")).toBe(false);
    expect(await verifyLineSignature(body + " ", await sign(body, "secret"), "secret")).toBe(false);
    expect(await verifyLineSignature(body, null, "secret")).toBe(false);
  });
});

describe("店舗名の判定", () => {
  it.each([
    ["白梅町", "hakubaicho"],
    ["北野白梅町店です", "hakubaicho"],
    ["京大前", "kyodaimae"],
    ["同志社前店", "doshisha"],
    ["ほりまる", "horimaru"],
    ["聖護院　お願いします", "shogoin"],
  ])("%s → %s", (t, id) => expect(detectStoreClaim(t, cfg)).toEqual({ kind: "store", storeId: id }));
  it("店舗名なし", () => expect(detectStoreClaim("おつかれさまです", cfg).kind).toBe("none"));
  it("複数の店舗名は判定しない", () => expect(detectStoreClaim("白梅町と聖護院", cfg).kind).toBe("ambiguous"));
});

describe("LINEイベントの処理", () => {
  beforeEach(() => {
    seq = 0;
  });

  it("店舗名 → 写真 の順で紐付き、解析の仕事が1件積まれる。画像はすぐ保存", async () => {
    const { deps, repo, stored } = makeDeps();
    expect(await handleEvent(textEv("白梅町"), deps)).toBe("claim_recorded");
    expect(await handleEvent(imageEv(T0 + 30_000), deps)).toBe("image_paired");
    expect(stored.size).toBe(1);
    expect([...repo.jobs.values()]).toEqual([expect.objectContaining({ kind: "ANALYZE_IMAGE", storeId: "hakubaicho" })]);
  });

  it("写真 → 店舗名 の順（後から店名）でも紐付く", async () => {
    const { deps, repo } = makeDeps();
    expect(await handleEvent(imageEv(T0), deps)).toBe("image_waiting_store");
    expect(await handleEvent(textEv("聖護院", T0 + 60_000), deps)).toBe("image_paired");
    expect([...repo.jobs.values()][0]).toMatchObject({ storeId: "shogoin" });
  });

  it("10分以上離れた店舗名とは紐付けない", async () => {
    const { deps, repo } = makeDeps();
    await handleEvent(textEv("白梅町", T0), deps);
    expect(await handleEvent(imageEv(T0 + 11 * 60_000), deps)).toBe("image_waiting_store");
    expect(repo.jobs.size).toBe(0);
  });

  it("別の人の店舗名とは紐付けない", async () => {
    const { deps } = makeDeps();
    await handleEvent(textEv("白梅町", T0, "UstaffA"), deps);
    expect(await handleEvent(imageEv(T0 + 10_000, "UstaffB"), deps)).toBe("image_waiting_store");
  });

  it("同じイベントが2回処理されても、画像の保存・仕事は1回だけ", async () => {
    const { deps, repo } = makeDeps();
    await handleEvent(textEv("京大前"), deps);
    const img = imageEv(T0 + 5_000);
    await handleEvent(img, deps);
    expect(await handleEvent(img, deps)).toBe("image_already_processed");
    expect(repo.jobs.size).toBe(1);
  });

  it("同じ写真の再送は「二重に数えない」と返信し、解析しない", async () => {
    const { deps, repo, replies, contents } = makeDeps();
    await handleEvent(textEv("ほりまる"), deps);
    const a = imageEv(T0 + 1_000);
    const b = imageEv(T0 + 2_000);
    contents.set(a.message!.id, "same");
    contents.set(b.message!.id, "same");
    await handleEvent(a, deps);
    expect(await handleEvent(b, deps)).toBe("image_duplicate");
    expect(repo.jobs.size).toBe(1);
    expect(replies.at(-1)?.text).toContain("二重に数えません");
  });

  it("店舗名が複数書かれていたら確認を返信し、紐付けない", async () => {
    const { deps, repo, replies } = makeDeps();
    await handleEvent(imageEv(T0), deps);
    await handleEvent(textEv("白梅町と聖護院", T0 + 1_000), deps);
    expect(repo.jobs.size).toBe(0);
    expect(replies.at(-1)?.text).toContain("店舗名を1つだけ");
  });

  it("事務員の「現金チェックOK」は現金チェックの仕事として積む", async () => {
    const { deps, repo } = makeDeps();
    expect(await handleEvent(textEv("同志社前 9/28〜9/30分 現金チェックOK", T0, "Uclerk"), deps)).toBe("cash_check_queued");
    expect([...repo.jobs.values()][0]).toMatchObject({ kind: "CASH_CHECK", userId: "Uclerk" });
  });

  it("投稿用グループ以外のメッセージは無視（グループIDの確認だけ応答）", async () => {
    const { deps, repo, replies } = makeDeps();
    expect(await handleEvent(imageEv(T0, "U1", "Cother"), deps)).toBe("ignored");
    expect(await handleEvent(textEv("#グループID", T0, "U1", "Cother"), deps)).toBe("group_id_replied");
    expect(replies.at(-1)?.text).toContain("Cother");
    expect(repo.images.size).toBe(0);
  });

  it("Botがグループに参加したらグループIDを返信", async () => {
    const { deps, replies } = makeDeps({ postGroupId: null });
    const ev: WebhookEvent = { type: "join", webhookEventId: "wj", timestamp: T0, replyToken: "rtj", source: { type: "group", groupId: "Cnew" } };
    expect(await handleEvent(ev, deps)).toBe("joined");
    expect(replies[0]?.text).toContain("Cnew");
  });

  it("正常時は返信しない（グループが騒がしくならない）。動作確認モードでは受付を返信", async () => {
    const quiet = makeDeps();
    await handleEvent(textEv("白梅町"), quiet.deps);
    await handleEvent(imageEv(T0 + 1_000), quiet.deps);
    expect(quiet.replies).toHaveLength(0);
    const debug = makeDeps({ debugAck: true });
    await handleEvent(textEv("白梅町"), debug.deps);
    await handleEvent(imageEv(T0 + 1_000), debug.deps);
    expect(debug.replies.at(-1)?.text).toContain("受付：白梅町店");
  });

  it("返信に失敗しても受付処理は続ける", async () => {
    const { deps, repo } = makeDeps({ debugAck: true });
    deps.line.reply = async () => {
      throw new Error("expired");
    };
    await handleEvent(textEv("白梅町"), deps);
    expect(await handleEvent(imageEv(T0 + 1_000), deps)).toBe("image_paired");
    expect(repo.jobs.size).toBe(1);
  });
});

describe("Webhookの受け口（Worker）", () => {
  function env() {
    const sent: unknown[] = [];
    const rows = new Set<string>();
    const db = {
      prepare: (sql: string) => ({
        bind: (...v: unknown[]) => ({
          run: async () => {
            const id = String(v[0]);
            const isNew = sql.includes("line_events") && !rows.has(id);
            if (isNew) rows.add(id);
            return { results: [], meta: { changes: isNew ? 1 : 0 } };
          },
        }),
      }),
    };
    return { sent, env: { DB: db, IMAGES: {}, EVENTS: { send: async (b: unknown) => void sent.push(b) }, LINE_CHANNEL_SECRET: "s3cret", LINE_CHANNEL_ACCESS_TOKEN: "t" } as any };
  }
  const body = JSON.stringify({ destination: "Ubot", events: [textEv("白梅町")] });

  it("署名が正しければ 200、キューに1件", async () => {
    const { env: e, sent } = env();
    const res = await worker.fetch(new Request("https://x/webhook", { method: "POST", body, headers: { "x-line-signature": await sign(body, "s3cret") } }), e, { waitUntil() {} });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("署名が不正なら 401（処理しない）", async () => {
    const { env: e, sent } = env();
    const res = await worker.fetch(new Request("https://x/webhook", { method: "POST", body, headers: { "x-line-signature": "bad" } }), e, { waitUntil() {} });
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("同じ webhookEventId は2回目以降キューに入れない（再送フラグ付きは除く）", async () => {
    const { env: e, sent } = env();
    const req = async () => worker.fetch(new Request("https://x/webhook", { method: "POST", body, headers: { "x-line-signature": await sign(body, "s3cret") } }), e, { waitUntil() {} });
    await req();
    await req();
    expect(sent).toHaveLength(1);
  });
});

describe("LINE APIクライアント", () => {
  it("トークンをヘッダーで送り、本文はログに出さずにエラーにする", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new LineClient("tok", (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("secret body", { status: 400 });
    }) as any);
    await expect(client.reply("rt", [{ type: "text", text: "hi" }])).rejects.toThrow("LINE API reply failed: 400");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });
  it("push は 409（同じ retryKey で送信済み）をエラーにしない", async () => {
    const client = new LineClient("tok", (async () => new Response("", { status: 409 })) as any);
    await expect(client.push("C1", [{ type: "text", text: "x" }], "11111111-1111-1111-1111-111111111111")).resolves.toBeUndefined();
  });
});

describe("Webhook本文のパース", () => {
  it("形の合わないイベントは捨てて続行", () => {
    const r = parseWebhook(JSON.stringify({ destination: "x", events: [{ foo: 1 }, textEv("a")] }));
    expect(r.events).toHaveLength(1);
    expect(r.skipped).toBe(1);
  });
});
