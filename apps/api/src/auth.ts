// Better Auth provides GitHub/Google login, selected on 2026-09-01.
// Email/password is a development-only option (NIMPLEX_DEV_EMAIL_AUTH=1)
// for programmatic E2E signup; clients expose it only when enabled.
// Authentication tables and organization tables remain loosely coupled through
// email and the organization-on-signup hook, allowing auth replacement independently.
import { account, type Db, orgMembers, orgs, session, user, verification } from "@nimplex/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

const DEV_SECRET = "nimplex-dev-secret-do-not-use-in-prod";

/** Expose configured login providers through /api/auth-providers. */
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
    // Development frontend origins and the API itself.
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
            // First signup, including social login, creates an organization and owner.
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
