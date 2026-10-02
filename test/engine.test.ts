import { describe, expect, it } from "vitest";
import { applySubmission } from "../src/matching/engine";
import { applyCashCheckMessage } from "../src/matching/clerk";
import { Ledger, recordKey } from "../src/matching/ledger";
import { evaluateRecord } from "../src/matching/status";
import { analyze2, oilRaw, passbook, row, salesRaw, testCtx } from "./helpers";
import type { RawExtraction } from "../src/extraction/schema";

const ctx = testCtx();

function submit(ledger: Ledger, sourceId: string, storeId: string, raw: RawExtraction, today: string, rawB?: RawExtraction) {
  applySubmission(ctx, ledger, { sourceId, storeId, postedOn: today, analysis: analyze2(raw, storeId, today, ctx.cfg, rawB) });
}
function status(ledger: Ledger, storeId: string, businessDate: string, today: string) {
  const rec = ledger.records.get(recordKey(storeId, businessDate));
  if (!rec) throw new Error("record not found");
  return evaluateRecord(ctx, ledger, rec, today);
}
const sales = (businessDate: string, deposit: number, rows: RawExtraction["passbook_rows"]) =>
  salesRaw({ businessDate, deposit, rows });

describe("白梅町・聖護院（小銭も翌日に一緒に入金）", () => {
  it("日計表と通帳の入金が一致 → OK", () => {
    const l = new Ledger();
    submit(l, "m1", "hakubaicho", sales("2026/9/28", 72260, passbook(100000, [["08-09-28", 50000], ["08-09-29", 72260]])), "2026-09-29");
    expect(status(l, "hakubaicho", "2026-09-28", "2026-09-29").overall).toBe("OK");
  });

  it("お札だけ入金（小銭不足）→ 小銭待ちにせず要確認", () => {
    const l = new Ledger();
    submit(l, "m1", "hakubaicho", sales("2026/9/28", 72260, passbook(100000, [["08-09-28", 50000], ["08-09-29", 72000]])), "2026-09-29");
    const s = status(l, "hakubaicho", "2026-09-28", "2026-09-29");
    expect(s.overall).toBe("NEEDS_REVIEW");
    expect(s.reasons.join()).toContain("小銭 260円 が入金されていない");
  });

  it("金額不一致 → 要確認（差額の材料を表示）", () => {
    const l = new Ledger();
    submit(l, "m1", "shogoin", sales("2026/9/28", 72260, passbook(100000, [["08-09-28", 50000], ["08-09-29", 71260]])), "2026-09-29");
    const s = status(l, "shogoin", "2026-09-28", "2026-09-29");
    expect(s.overall).toBe("NEEDS_REVIEW");
    expect(s.reasons.join()).toContain("71,260円");
  });

  it("営業日と同じ日付の入金は翌日入金とみなさない（営業日≠入金日）", () => {
    const l = new Ledger();
    submit(l, "m1", "hakubaicho", sales("2026/9/28", 72260, passbook(100000, [["08-09-27", 50000], ["08-09-28", 72260]])), "2026-09-29");
    expect(status(l, "hakubaicho", "2026-09-28", "2026-09-29").overall).toBe("NEEDS_REVIEW");
  });
});

describe("京大前・ほりまる（小銭の後日入金）", () => {
  it("お札だけ入金 → 小銭入金待ち → 追加入金で完了（過去分更新）", () => {
    const l = new Ledger();
    const base: [string, number][] = [["08.09.30", 40000], ["08.10.01", 65000]];
    submit(l, "m1", "horimaru", sales("2026/9/30", 65320, passbook(300000, base)), "2026-10-01");
    let s = status(l, "horimaru", "2026-09-30", "2026-10-01");
    expect(s).toMatchObject({ overall: "COIN_PENDING", remaining: 320 });

    // 数日後、小銭の入金が記帳された通帳（前の行も写っている）を投稿
    submit(l, "m2", "horimaru", sales("2026/10/1", 51000, passbook(300000, [...base, ["08.10.02", 51000], ["08.10.02", 320]])), "2026-10-02");
    s = status(l, "horimaru", "2026-09-30", "2026-10-02");
    expect(s).toMatchObject({ overall: "OK", deposited: 65320, remaining: 0 });
    expect(l.events.some((e) => e.type === "COIN_DEPOSIT_MATCHED" && e.businessDate === "2026-09-30")).toBe(true);
    expect(status(l, "horimaru", "2026-10-01", "2026-10-02").overall).toBe("OK");
  });

  it("期限（3銀行営業日）を過ぎても小銭が来なければ要確認", () => {
    const l = new Ledger();
    submit(l, "m1", "kyodaimae", sales("2026/9/30", 65320, passbook(300000, [["08.09.30", 40000], ["08.10.01", 65000]])), "2026-10-01");
    expect(status(l, "kyodaimae", "2026-09-30", "2026-10-05").overall).toBe("COIN_PENDING");
    expect(status(l, "kyodaimae", "2026-09-30", "2026-10-06").overall).toBe("NEEDS_REVIEW");
  });

  it("連休明けにまとめて入金された小銭を、金額で各営業日へ自動で振り分ける", () => {
    const l = new Ledger();
    // 9/18(金)〜9/22(祝) の5営業日。お札は毎日翌日、小銭は連休明け 9/24 にまとめて
    const days = [
      ["2026/9/18", "08.09.19", 41815],
      ["2026/9/19", "08.09.20", 38062],
      ["2026/9/20", "08.09.21", 52047],
      ["2026/9/21", "08.09.22", 47431],
      ["2026/9/22", "08.09.23", 44876],
    ] as const;
    const entries: [string, number][] = [];
    days.forEach(([bd, dep, target], i) => {
      entries.push([dep, Math.floor(target / 1000) * 1000]);
      submit(l, `d${i}`, "horimaru", sales(bd, target, passbook(300000, entries)), dep.replace(/^08\./, "2026-").replace(/\./g, "-"));
    });
    for (const [bd, , t] of days) {
      expect(status(l, "horimaru", bd.replace(/\//g, "-").replace(/-(\d)-/, "-0$1-"), "2026-09-23").overall).toBe("COIN_PENDING");
      void t;
    }
    // 9/23(祝)営業分はお札＋小銭を一緒に 9/24 入金、そのあと小銭5行
    const final: [string, number][] = [...entries, ["08.09.24", 45936], ["08.09.24", 815], ["08.09.24", 62], ["08.09.24", 47], ["08.09.24", 431], ["08.09.24", 876]];
    submit(l, "d9", "horimaru", sales("2026/9/23", 45936, passbook(300000, final)), "2026-09-24");
    for (const d of ["2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23"]) {
      expect(status(l, "horimaru", d, "2026-09-24").overall, d).toBe("OK");
    }
  });

  it("同じ金額の小銭待ちが2日分あれば、どちらの分か推測せず要確認", () => {
    const l = new Ledger();
    const e: [string, number][] = [["08.09.29", 40000], ["08.09.30", 41000]];
    submit(l, "a", "kyodaimae", sales("2026/9/28", 40500, passbook(300000, e.slice(0, 1))), "2026-09-29");
    submit(l, "b", "kyodaimae", sales("2026/9/29", 41500, passbook(300000, e)), "2026-09-30");
    submit(l, "c", "kyodaimae", sales("2026/9/30", 39000, passbook(300000, [...e, ["08.10.01", 39000], ["08.10.01", 500]])), "2026-10-01");
    expect(status(l, "kyodaimae", "2026-09-28", "2026-10-01").overall).toBe("NEEDS_REVIEW");
    expect(status(l, "kyodaimae", "2026-09-29", "2026-10-01").overall).toBe("NEEDS_REVIEW");
  });
});

describe("同志社前（小銭は事務員が現金確認）", () => {
  const doshisha = () =>
    salesRaw({
      storeName: "アホウどり 同志社前店",
      businessDate: "2026/9/28 (月)",
      deposit: 65320,
      onHand: 115320,
      float: 50000,
      denoms: [270, 50, 2000, 68000, 15000, 30000],
      rows: passbook(200000, [["08-09-28", 55000], ["08-09-29", 65000]]),
    });

  it("お札入金OK → 小銭は事務確認待ち（未完了扱いにしない）→ 現金チェックOKで最終確認完了", () => {
    const l = new Ledger();
    submit(l, "m1", "doshisha", doshisha(), "2026-09-29");
    expect(status(l, "doshisha", "2026-09-28", "2026-09-29").overall).toBe("CLERK_PENDING");

    const r = applyCashCheckMessage(ctx, l, { messageId: "t1", senderUserId: "U_clerk", text: "9/28〜9/30分 現金チェックOK", receivedAt: "2026-10-02T10:00:00+09:00", receivedOn: "2026-10-02" });
    expect(r).toBe("recorded");
    expect(status(l, "doshisha", "2026-09-28", "2026-10-02").overall).toBe("FINAL_CONFIRMED");
    expect(l.cashChecks.get("t1")).toMatchObject({ senderUserId: "U_clerk", from: "2026-09-28", to: "2026-09-30" });
  });

  it("登録外の人の「現金チェックOK」は反映しない", () => {
    const l = new Ledger();
    submit(l, "m1", "doshisha", doshisha(), "2026-09-29");
    const r = applyCashCheckMessage(ctx, l, { messageId: "t1", senderUserId: "U_someone", text: "9/28〜9/30分 現金チェックOK", receivedAt: "", receivedOn: "2026-10-02" });
    expect(r).toBe("rejected");
    expect(status(l, "doshisha", "2026-09-28", "2026-10-02").overall).toBe("CLERK_PENDING");
    expect(l.reviewMessages).toHaveLength(1);
  });

  it("期間外の営業日は更新しない", () => {
    const l = new Ledger();
    submit(l, "m1", "doshisha", doshisha(), "2026-09-29");
    applyCashCheckMessage(ctx, l, { messageId: "t1", senderUserId: "U_clerk", text: "9/25〜9/27分 現金チェックOK", receivedAt: "", receivedOn: "2026-10-02" });
    expect(status(l, "doshisha", "2026-09-28", "2026-10-02").overall).toBe("CLERK_PENDING");
  });
});

describe("廃油（油入金）", () => {
  const oilRows = (entries: [string, number, string?][]) => {
    let bal = 300000;
    const rows = [row("08.09.20", "1,000", "*300,000")];
    for (const [d, a, note] of entries) {
      bal += a;
      rows.push(row(d, `*${a.toLocaleString("en-US")}`, `¥${bal.toLocaleString("en-US")}`, { note }));
    }
    return rows;
  };

  it("祝日に回収 → 次の銀行営業日に入金 → OK", () => {
    const l = new Ledger();
    submit(l, "o1", "horimaru", oilRaw({ addressee: "ほりまる 様", date: "26年9月22日", amount: "300円", rows: oilRows([["08.09.24", 815], ["08.09.24", 300, "油入金"]]) }), "2026-09-24");
    const oil = [...l.oils.values()][0]!;
    expect(oil.deposit).toMatchObject({ date: "2026-09-24", amount: 300 });
  });

  it("平日は同日入金 → OK、翌日以降の入金は見つからない扱い（要確認）", () => {
    const l = new Ledger();
    submit(l, "o1", "horimaru", oilRaw({ date: "26年9月29日", amount: "300円", rows: oilRows([["08.09.29", 300]]) }), "2026-09-29");
    expect([...l.oils.values()][0]!.deposit).not.toBeNull();
    const l2 = new Ledger();
    submit(l2, "o1", "horimaru", oilRaw({ date: "26年9月29日", amount: "300円", rows: oilRows([["08.09.30", 300]]) }), "2026-09-30");
    expect([...l2.oils.values()][0]!.issue?.code).toBe("OIL_NOT_FOUND");
  });

  it("同じ金額の入金が2行 → 手書き「油入金」メモで特定、メモがなければ要確認", () => {
    const l = new Ledger();
    submit(l, "o1", "horimaru", oilRaw({ date: "26年9月29日", amount: "300円", rows: oilRows([["08.09.29", 300], ["08.09.29", 300, "油入金"]]) }), "2026-09-29");
    expect([...l.oils.values()][0]!.deposit).not.toBeNull();
    const l2 = new Ledger();
    submit(l2, "o1", "horimaru", oilRaw({ date: "26年9月29日", amount: "300円", rows: oilRows([["08.09.29", 300], ["08.09.29", 300]]) }), "2026-09-29");
    expect([...l2.oils.values()][0]!.issue?.code).toBe("OIL_AMBIGUOUS");
  });

  it("「油入金」メモのある行は小銭として使わない", () => {
    const l = new Ledger();
    submit(l, "m1", "horimaru", sales("2026/9/28", 40300, passbook(300000, [["08.09.28", 1000], ["08.09.29", 40000]])), "2026-09-29");
    const rows = passbook(300000, [["08.09.28", 1000], ["08.09.29", 40000]]);
    rows.push(row("08.09.30", "*300", "*341,300", { note: "油入金" }));
    submit(l, "m2", "horimaru", sales("2026/9/29", 1000, rows), "2026-09-30");
    expect(status(l, "horimaru", "2026-09-28", "2026-09-30").overall).toBe("COIN_PENDING");
  });
});

describe("重複・判読不能・再提出", () => {
  it("同じ投稿IDを2回処理しても二重加算しない", () => {
    const l = new Ledger();
    const raw = sales("2026/9/28", 72260, passbook(100000, [["08-09-28", 50000], ["08-09-29", 72260]]));
    submit(l, "m1", "hakubaicho", raw, "2026-09-29");
    submit(l, "m1", "hakubaicho", raw, "2026-09-29");
    expect(status(l, "hakubaicho", "2026-09-28", "2026-09-29")).toMatchObject({ overall: "OK", deposited: 72260 });
    expect(l.events.some((e) => e.type === "DUPLICATE_SOURCE_IGNORED")).toBe(true);
  });

  it("同じ写真を別の投稿として再送しても、同じ通帳行は二重に使わない", () => {
    const l = new Ledger();
    const raw = sales("2026/9/30", 65320, passbook(300000, [["08.09.30", 40000], ["08.10.01", 65000]]));
    submit(l, "m1", "kyodaimae", raw, "2026-10-01");
    submit(l, "m2", "kyodaimae", raw, "2026-10-01");
    expect(status(l, "kyodaimae", "2026-09-30", "2026-10-01")).toMatchObject({ overall: "COIN_PENDING", deposited: 65000 });
  });

  it("ボヤけた写真 → 画像判読不能 → 撮り直しで OK", () => {
    const l = new Ledger();
    const blurry = sales("2026/9/28", 72260, passbook(100000, [["08-09-28", 50000], ["08-09-29", 72260]]));
    blurry.image_quality.blurry = true;
    submit(l, "m1", "hakubaicho", blurry, "2026-09-29");
    expect(status(l, "hakubaicho", "2026-09-28", "2026-09-29").overall).toBe("UNREADABLE");
    submit(l, "m2", "hakubaicho", sales("2026/9/28", 72260, passbook(100000, [["08-09-28", 50000], ["08-09-29", 72260]])), "2026-09-29");
    expect(status(l, "hakubaicho", "2026-09-28", "2026-09-29").overall).toBe("OK");
  });

  it("同じ営業日の日計表が投稿によって違う金額 → 要確認", () => {
    const l = new Ledger();
    submit(l, "m1", "hakubaicho", sales("2026/9/28", 72260, passbook(100000, [["08-09-28", 50000], ["08-09-29", 72260]])), "2026-09-29");
    submit(l, "m2", "hakubaicho", sales("2026/9/28", 72560, passbook(100000, [["08-09-28", 50000], ["08-09-29", 72260]])), "2026-09-29");
    expect(status(l, "hakubaicho", "2026-09-28", "2026-09-29").overall).toBe("NEEDS_REVIEW");
  });

  it("対象の入金行が通帳の先頭行（前の行がなく残高検算できない）→ 要確認", () => {
    const l = new Ledger();
    const raw = sales("2026/9/28", 72260, [row("08-09-29", "*72,260", "*172,260")]);
    submit(l, "m1", "hakubaicho", raw, "2026-09-29");
    expect(status(l, "hakubaicho", "2026-09-28", "2026-09-29").overall).toBe("NEEDS_REVIEW");
  });
});
