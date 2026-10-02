import { z } from "zod";

/**
 * 店舗・銀行・判定ルールの設定。
 * 運用ルールの変更はコードではなく config/stores.json の編集で行う。
 */

export const YearFormat = z.enum([
  /** 和暦（令和）の下2桁。例: "08" → 令和8年 → 2026 */
  "reiwa2",
  /** 西暦の下2桁。例: "26" → 2026 */
  "western2",
  /** 西暦4桁。例: "2026" */
  "western4",
]);
export type YearFormat = z.infer<typeof YearFormat>;

export const CoinPolicy = z.enum([
  /** 小銭もお札と一緒に入金する（後日入金なし） */
  "SAME_DAY",
  /** 小銭は後日（翌銀行営業日など）に別途入金されることがある */
  "DEFERRED",
  /** 小銭は入金しない。事務員が現金を確認する */
  "CLERK_CHECK",
]);
export type CoinPolicy = z.infer<typeof CoinPolicy>;

export const ReceiptCheck = z.enum([
  /** 金種の合計 ＝ 在高実績 */
  "denominationsSum",
  /** 在高実績 − 翌準備金 ＝ 預入金 */
  "onHandMinusFloat",
]);
export type ReceiptCheck = z.infer<typeof ReceiptCheck>;

export const ReceiptLabels = z.object({
  /** 営業日を表す項目（例: 営業日、レポート期間） */
  businessDate: z.string().min(1),
  /** 銀行入金対象額（例: 預入金、銀行入金額） */
  deposit: z.string().min(1),
  /** レジ内の現金合計（例: 在高実績、現金残高(点検)） */
  cashOnHand: z.string().min(1),
  /** 翌日の釣銭準備金（例: 翌準備金、繰越準備金） */
  nextDayFloat: z.string().min(1),
  /** 金種別の内訳の見出し（例: 1円硬貨〜1万円紙幣、点検金種） */
  denominations: z.string().min(1),
});
export type ReceiptLabels = z.infer<typeof ReceiptLabels>;

const StoreConfig = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).min(1),
  bank: z.string().min(1),
  coinPolicy: CoinPolicy,
  receipt: z.object({
    /** レジ精算票の項目名（印字どおり）。null は書式未登録（必ず要確認） */
    labels: ReceiptLabels.nullable(),
    yearFormat: YearFormat,
    checks: z.array(ReceiptCheck),
    /**
     * 検算なしの運用を明示的に許可する（テスト用）。
     * 本番では、2系統のAIが同じ誤読をした場合に備え、書式を登録する店舗には検算を必須とする。
     */
    allowWithoutChecks: z.boolean().optional(),
  }),
});
export type StoreConfig = z.infer<typeof StoreConfig>;

export const AppConfigSchema = z
  .object({
    billUnit: z.number().int().positive(),
    banks: z.record(
      z.string(),
      z.object({
        name: z.string(),
        yearFormat: YearFormat,
        /** 売上・廃油の入金として扱う摘要（例: ATM）。振込などはこれに含めない */
        depositDescriptions: z.array(z.string().min(1)).min(1),
      }),
    ),
    stores: z.array(StoreConfig).min(1),
    oilReceipt: z.object({
      yearFormat: YearFormat,
      noteKeywords: z.array(z.string().min(1)),
    }),
    excludedDescriptionKeywords: z.array(z.string().min(1)),
    rules: z.object({
      depositGraceDays: z.number().int().min(0),
      coinMaxWaitBankDays: z.number().int().min(1),
      oilGraceDays: z.number().int().min(0),
      dateSanityPastDays: z.number().int().positive(),
      dateSanityFutureDays: z.number().int().min(0),
      requireBalanceChain: z.boolean(),
      minFieldConfidence: z.number().min(0).max(1),
    }),
    cashCheck: z.object({
      storeId: z.string(),
      maxRangeDays: z.number().int().positive(),
      clerkUserIds: z.array(z.string()),
    }),
  })
  .superRefine((cfg, ctx) => {
    const ids = new Set<string>();
    for (const s of cfg.stores) {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", message: `店舗IDが重複: ${s.id}` });
      ids.add(s.id);
      if (!cfg.banks[s.bank]) ctx.addIssue({ code: "custom", message: `未定義の銀行: ${s.bank} (${s.id})` });
      if (s.receipt.labels !== null && s.receipt.checks.length === 0 && !s.receipt.allowWithoutChecks) {
        ctx.addIssue({ code: "custom", message: `${s.name}: レジ精算票の検算(checks)が未設定。誤読対策のため必須` });
      }
    }
    if (!ids.has(cfg.cashCheck.storeId)) {
      ctx.addIssue({ code: "custom", message: `cashCheck.storeId が店舗に存在しない: ${cfg.cashCheck.storeId}` });
    }
  });

export type AppConfig = z.infer<typeof AppConfigSchema>;

export function parseConfig(raw: unknown): AppConfig {
  return AppConfigSchema.parse(raw);
}

export function getStore(cfg: AppConfig, storeId: string): StoreConfig {
  const s = cfg.stores.find((x) => x.id === storeId);
  if (!s) throw new Error(`未登録の店舗ID: ${storeId}`);
  return s;
}

export function bankOf(cfg: AppConfig, store: StoreConfig) {
  const b = cfg.banks[store.bank];
  if (!b) throw new Error(`未定義の銀行: ${store.bank}`);
  return b;
}
