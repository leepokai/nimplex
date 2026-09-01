// Console 登入走 Better Auth。對外只提供 GitHub / Google 社群登入（2026-09-01 定案）；
// email + password 降級為開發用開關（NIMPLEX_DEV_EMAIL_AUTH=1）——e2e 冒煙腳本靠它
// 程式化註冊，UI 上除非開關打開否則不出現。
// auth 層只認得 user / session 四張表；租戶層（orgs / org_members）靠
// 「註冊即建 org」的 hook 與 email 對應鬆耦合——換掉 auth 方案不動任何業務表。
import { account, type Db, orgMembers, orgs, session, user, verification } from "@nimplex/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

const DEV_SECRET = "nimplex-dev-secret-do-not-use-in-prod";

/** 哪些登入方式已設定好。公開給 /api/auth-providers，讓 AuthScreen 只渲染可用的按鈕。 */
export function authProviderStatus() {
  return {
    github: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    email: process.env.NIMPLEX_DEV_EMAIL_AUTH === "1",
  };
}

export function createAuth(db: Db) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    console.warn(
      "[nimplex] BETTER_AUTH_SECRET 未設定，改用開發用固定 secret。正式環境務必設定（openssl rand -base64 32）。",
    );
  }
  const status = authProviderStatus();
  if (!status.github && !status.google && !status.email) {
    console.warn(
      "[nimplex] 沒有任何登入方式可用：設 GITHUB_CLIENT_ID/SECRET 或 GOOGLE_CLIENT_ID/SECRET（.env.example 有步驟），或開發期先開 NIMPLEX_DEV_EMAIL_AUTH=1。",
    );
  }

  return betterAuth({
    baseURL: process.env.NIMPLEX_PUBLIC_URL ?? "http://localhost:8787",
    basePath: "/api/auth",
    secret: secret ?? DEV_SECRET,
    // console dev server（vite proxy）與 API 本體
    trustedOrigins: (
      process.env.NIMPLEX_TRUSTED_ORIGINS ?? "http://localhost:5173,http://localhost:8787"
    ).split(","),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
    emailAndPassword: { enabled: status.email },
    socialProviders: {
      ...(status.github
        ? {
            github: {
              clientId: process.env.GITHUB_CLIENT_ID as string,
              clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
            },
          }
        : {}),
      ...(status.google
        ? {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID as string,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
            },
          }
        : {}),
    },
    databaseHooks: {
      user: {
        create: {
          after: async (newUser) => {
            // 註冊即有自己的 org（social 首次登入也走這裡）：owner 一人一格。
            const [org] = await db
              .insert(orgs)
              .values({ name: newUser.name ? `${newUser.name} 的組織` : newUser.email })
              .returning();
            if (!org) throw new Error("failed to create org for new user");
            await db
              .insert(orgMembers)
              .values({ orgId: org.id, email: newUser.email, role: "owner" });
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
