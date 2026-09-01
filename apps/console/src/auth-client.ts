import { createAuthClient } from "better-auth/react";

/**
 * Better Auth 的瀏覽器端。走同源的 /api/auth（vite dev 由 proxy 轉到 :8787），
 * session 放 httpOnly cookie——org API key 永不進瀏覽器，這條鐵則由型別保證：
 * console 的 Nimplex client 沒有 apiKey，身分全靠這裡的 cookie。
 */
export const authClient = createAuthClient();
