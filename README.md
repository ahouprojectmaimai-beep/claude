# 売上金 銀行入金チェック自動化

株式会社アホウプロジェクト 5店舗の「通帳＋レジ精算票」写真から、銀行入金を自動照合するシステム。

- 設計書: [docs/PHASE1_design.md](docs/PHASE1_design.md)
- 進捗報告: [docs/PHASE2_report.md](docs/PHASE2_report.md)

## 基本方針
- AIは「写真の文字を書き写す」だけ。金額の一致・差額・ステータスはプログラムで決める
- 分からないものは推測せず「要確認」「画像判読不能」にする（誤ってOKにしないことが最優先）
- 店舗ごとのルール・祝日は `config/` のデータで管理（コード変更不要）

## 構成（PHASE 2 時点）
| ディレクトリ | 役割 |
|---|---|
| `config/stores.json` | 店舗・銀行・判定ルール |
| `config/holidays.json` | 銀行休業日（毎年更新） |
| `src/extraction/` | AIによる画像の書き写し（Claude。差し替え可能） |
| `src/validation/` | 数値化・2系統の突き合わせ・通帳の残高検算・日計表の検算 |
| `src/matching/` | 営業日との紐付け・小銭の後日入金・同志社前の事務確認・廃油 |
| `src/pipeline/` | 画像1枚の解析の流れ |
| `scripts/` | 実画像での動作確認用コマンド |
| `test/` | 自動テスト（架空の数字のみ） |

## 使い方
```bash
npm install
npm test            # 自動テスト
npm run typecheck   # 型チェック

# 実画像をClaudeで解析（APIキーは環境変数で渡す。コードやGitには書かない）
ANTHROPIC_API_KEY=... npm run analyze -- --store doshisha --today 2026-09-29 --image testdata/private/photo.jpg --save-dir testdata/private/out

# 保存した抽出結果から判定を再現（APIキー不要）
npm run replay -- --store doshisha --today 2026-09-29 --a testdata/private/out/xxx.json
```

## セキュリティ
- 実画像・抽出結果（銀行情報を含む）は `testdata/private/` に置く。`.gitignore` 済みで絶対にコミットしない
- APIキー等の秘密情報は環境変数のみ。ログに残高・口座情報を出さない
