# TUMIKI 日程調整・自動予約システム

予約URLを送るだけで、お客様が空き時間を選んで予約 → Googleカレンダー登録・Meet発行・確認メールまで自動。

- 設計: [docs/DESIGN.md](docs/DESIGN.md) / セットアップ: [docs/SETUP.md](docs/SETUP.md)
- Cloudflare Workers + D1 + Hono、画面はビルド不要の素のJS

```bash
npm install
npm test          # 空き時間・二重予約・障害時整合性・同期など 37項目
npm run typecheck
```
