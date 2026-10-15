# 0円で公開する構成（推奨）
| 要素 | 使うもの | 費用 |
|---|---|---|
| 公開URL | Cloudflare標準の `xxx.workers.dev`（HTTPS付き） | 0円 |
| 実行・DB・定期処理 | Cloudflare Workers / D1 / Cron（無料枠） | 0円 |
| カレンダー | Google Calendar API | 0円 |
| メール | Gmail送信（`MAIL_PROVIDER="gmail"`、既定） | 0円 |

無料枠の目安: Workers 1日10万リクエスト、D1 5GB。この予約システムの規模なら十分に収まります。
独自ドメインやResendを使う場合のみ費用が発生します（任意）。

CLI（wrangler）が使えない場合は、Cloudflareダッシュボードの「Workers & Pages → Create → GitHubに接続」でも公開できます（ルートディレクトリは `tumiki-booking`）。

# セットアップ手順（初回のみ・約30分）

## 1. Google側の準備（Google Cloud Console）
1. プロジェクトを作成 → 「APIとサービス」→ **Google Calendar API** を有効化（Gmail送信を使う場合は Gmail API も）
2. 「OAuth同意画面」: ユーザーの種類は「外部」、アプリ名「TUMIKI予約」。スコープに
   `calendar.events` / `calendar.freebusy` / `calendar.calendarlist.readonly`（Gmail送信なら `gmail.send`）を追加
   **→ 公開ステータスを「本番環境」にする**（「テスト」のままだとリフレッシュトークンが7日で失効します）
3. 「認証情報」→ OAuthクライアントID（種類: ウェブアプリ）を作成
   承認済みリダイレクトURI: `https://<公開URL>/api/admin/oauth/callback`
   → クライアントID / シークレットを控える

## 2. Cloudflare側
```bash
cd tumiki-booking && npm install
npx wrangler login
npx wrangler d1 create tumiki-booking        # 出力された database_id を wrangler.toml に貼る
npm run db:migrate:remote
# 秘密情報（画面・Gitには出ません）
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ENCRYPTION_KEY       # ランダムな長い文字列（OAuthトークン暗号化用）
npx wrangler secret put SESSION_SECRET       # 別のランダムな長い文字列（ログインCookie署名用）
```
`wrangler.toml` の `PUBLIC_BASE_URL` / `ADMIN_EMAIL` / `MAIL_FROM` を自分の値に変更 → `npm run deploy`
（`openssl rand -base64 32` で乱数が作れます）

## 3. メール送信（どちらか）
- **Gmail（0円・既定）**: 初回ログイン時にGmail送信も許可するだけ。送信元は管理者のGmailアドレス（1日500通まで）
- **Resend（任意）**: `MAIL_PROVIDER="resend"` と `MAIL_FROM`、`RESEND_API_KEY`。独自ドメインが必要

## 4. 接続
`https://<公開URL>/admin` を開き「Googleでログイン」→ カレンダーの許可。これで予約URL（`https://<公開URL>/`）が使えます。
管理画面の「予約設定」で曜日・時間帯・事務所住所を設定してください。

## 5. ロゴ・ブランドカラー
- `public/brand/logo.svg`（画面）と `public/brand/logo.png`（メール用・透過PNG）を公式素材に差し替え
- 色は `public/css/tokens.css` だけで定義（メールの色は `src/lib/mail.ts` 内の同じ値）

## ローカル確認
`.dev.vars` に上記の値を書いて `npm run db:migrate:local && npm run dev`（`.dev.vars` はGit管理外）
