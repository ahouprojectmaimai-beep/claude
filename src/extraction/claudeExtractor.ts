import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { buildPrompt, PROMPT_VERSION, type PromptVariant } from "./prompt";
import { RawExtraction, type ExtractionRecord } from "./schema";
import type { Extractor, ExtractionRequest } from "./extractor";

export interface ClaudeExtractorOptions {
  /** APIキーはコードに書かない。省略時は SDK が環境変数 ANTHROPIC_API_KEY を読む */
  client?: Anthropic;
  model?: string;
  variant: PromptVariant;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/**
 * Claude Vision による抽出。
 * - 構造化出力（JSONスキーマ強制）で受け取り、SDK側でスキーマ検証する
 * - 安全分類器による拒否に備え server-side fallback を有効化（応答の model を記録する）
 * - 失敗は例外ではなく error 付きレコードで返す（呼び出し側が「要確認」にする）
 */
export class ClaudeExtractor implements Extractor {
  readonly id: string;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly variant: PromptVariant;
  private readonly effort: NonNullable<ClaudeExtractorOptions["effort"]>;

  constructor(opts: ClaudeExtractorOptions) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? "claude-opus-5-5";
    this.variant = opts.variant;
    this.effort = opts.effort ?? "high";
    this.id = `claude:${this.model}:${this.variant}`;
  }

  async extract(req: ExtractionRequest): Promise<ExtractionRecord> {
    const startedAt = new Date().toISOString();
    const base = { extractorId: this.id, promptVersion: `${PROMPT_VERSION}/${this.variant}`, startedAt };
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: this.effort, format: betaZodOutputFormat(RawExtraction) },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: req.mediaType, data: req.imageBase64 } },
              { type: "text", text: buildPrompt(this.variant, req.receiptLabels) },
            ],
          },
        ],
      });
      const finishedAt = new Date().toISOString();
      if (response.stop_reason !== "end_turn") {
        return { ...base, model: response.model, finishedAt, result: null, error: `AI応答が途中で終了: ${response.stop_reason}` };
      }
      if (!response.parsed_output) {
        return { ...base, model: response.model, finishedAt, result: null, error: "AI応答がスキーマに合わない" };
      }
      return { ...base, model: response.model, finishedAt, result: response.parsed_output, error: null };
    } catch (e) {
      // ログに画像や銀行情報を出さない。エラー種別とメッセージのみ
      const msg = e instanceof Anthropic.APIError ? `API ${e.status ?? "?"}: ${e.name}` : e instanceof Error ? e.name : "unknown";
      return { ...base, model: this.model, finishedAt: new Date().toISOString(), result: null, error: `AI呼び出し失敗 (${msg})` };
    }
  }
}
