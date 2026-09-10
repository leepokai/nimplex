// Shared by the e2e and demo scripts: dev-only email sign-up and cookie-scoped requests.
import assert from "node:assert/strict";

export const API = process.env.NIMPLEX_BASE_URL ?? "http://localhost:8787";
export const ok = (label: string) => console.log(`  ok ${label}`);

export async function signUp(label: string) {
  const email = `e2e-${label}-${Date.now()}@example.com`;
  const res = await fetch(`${API}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: API },
    body: JSON.stringify({ name: `E2E ${label}`, email, password: "password1234" }),
  });
  assert.equal(res.ok, true, `sign-up failed: ${res.status} ${await res.clone().text()}`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert.ok(cookie.length > 0, "sign-up returned no session cookie");
  return { email, cookie };
}

export async function sessionFetch(cookie: string, path: string, init: RequestInit = {}) {
  return fetch(`${API}${path}`, {
    ...init,
    headers: { cookie, "content-type": "application/json", ...init.headers },
  });
}

/** Sign up a fresh user and mint an org API key. */
export async function freshApiKey(label: string): Promise<string> {
  const user = await signUp(label);
  const res = await sessionFetch(user.cookie, "/v1/api-keys", {
    method: "POST",
    body: JSON.stringify({ name: label }),
  });
  assert.equal(res.status, 201, `api key failed: ${res.status}`);
  return ((await res.json()) as { key: string }).key;
}
