import type { MailEnv } from "../lib/mail.ts";

export type Env = MailEnv & {
  DB: D1Database;
  SESSION_SECRET: string;
  ADMIN_EMAIL: string;
};
