import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { authClient } from "./auth-client.ts";
import { Logo } from "./Logo.tsx";

/**
 * 登入畫面：只提供 GitHub / Google 社群登入（Better Auth）。
 * 按鈕由 /api/auth-providers 決定——沒設定憑證的 provider 不會出現；
 * email + password 是開發用後門（NIMPLEX_DEV_EMAIL_AUTH=1 才開），供 e2e 腳本用。
 * 首次登入即自動擁有一個 organization（server 端 hook 建立）。
 */

type ProviderStatus = { github: boolean; google: boolean; email: boolean };

function GitHubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export function AuthScreen() {
  const providers = useQuery({
    queryKey: ["auth-providers"],
    queryFn: async (): Promise<ProviderStatus> => {
      const res = await fetch("/api/auth-providers");
      if (!res.ok) throw new Error("讀不到登入設定");
      return (await res.json()) as ProviderStatus;
    },
  });

  const [pending, setPending] = useState<"github" | "google" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDevForm, setShowDevForm] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [devMode, setDevMode] = useState<"signin" | "signup">("signin");

  const social = async (provider: "github" | "google") => {
    setPending(provider);
    setError(null);
    // callbackURL 用 console 自己的 origin：OAuth 回跳到 API（:8787）種完 cookie 後，
    // 要把人送回 console，而不是留在 API 網域。
    const result = await authClient.signIn.social({
      provider,
      callbackURL: window.location.origin,
    });
    if (result.error) {
      setPending(null);
      setError(result.error.message ?? `${provider} 登入失敗，再試一次`);
    }
    // 成功時瀏覽器會整頁跳轉去 OAuth，不用收 pending
  };

  const devSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const result =
      devMode === "signin"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ name: email, email, password });
    if (result.error) setError(result.error.message ?? "認證失敗");
  };

  const none =
    providers.isSuccess &&
    !providers.data.github &&
    !providers.data.google &&
    !providers.data.email;

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <Logo />
          Nimplex
        </div>
        <p className="auth-lede">
          登入 console。首次登入即自動擁有一個 organization——你的三個插槽與 API key 都在裡面。
        </p>

        {providers.data?.github ? (
          <button
            type="button"
            className="btn auth-social"
            disabled={pending !== null}
            onClick={() => void social("github")}
          >
            <GitHubMark />
            {pending === "github" ? "前往 GitHub…" : "用 GitHub 繼續"}
          </button>
        ) : null}

        {providers.data?.google ? (
          <button
            type="button"
            className="btn auth-social"
            disabled={pending !== null}
            onClick={() => void social("google")}
          >
            <GoogleMark />
            {pending === "google" ? "前往 Google…" : "用 Google 繼續"}
          </button>
        ) : null}

        {none ? (
          <div className="auth-setup">
            <p className="strong">還沒設定登入方式</p>
            <p>
              在專案根目錄的 <code>.env</code> 填入 GitHub / Google OAuth 憑證後重啟 API （步驟見{" "}
              <code>.env.example</code>），或開發期先設 <code>NIMPLEX_DEV_EMAIL_AUTH=1</code>。
            </p>
          </div>
        ) : null}

        {error ? <div className="errnote">{error}</div> : null}

        {providers.data?.email ? (
          showDevForm ? (
            <form className="auth-devform" onSubmit={devSubmit}>
              <div className="auth-devform-head">
                開發用 email 登入
                <button
                  type="button"
                  className="auth-switch"
                  onClick={() => setDevMode((m) => (m === "signin" ? "signup" : "signin"))}
                >
                  {devMode === "signin" ? "改為註冊" : "改為登入"}
                </button>
              </div>
              <label className="field" htmlFor="auth-email">
                <span className="field-label">Email</span>
                <input
                  id="auth-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </label>
              <label className="field" htmlFor="auth-password">
                <span className="field-label">密碼</span>
                <input
                  id="auth-password"
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="至少 8 個字元"
                  autoComplete={devMode === "signin" ? "current-password" : "new-password"}
                />
              </label>
              <button type="submit" className="btn primary auth-submit">
                {devMode === "signin" ? "登入" : "註冊"}
              </button>
            </form>
          ) : (
            <button type="button" className="auth-switch" onClick={() => setShowDevForm(true)}>
              開發用 email 登入
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}
