import type { OrgRole } from "@nimplex/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { nimplex } from "../client.ts";
import { Badge, Empty, ErrorNote, Panel } from "../ui.tsx";

/**
 * Org members：登入 console 的人（owner / admin / member；Better Auth）。
 * owner 管帳與成員；admin 管三插槽與 key；member 唯讀＋開 run。
 * 「人」的身分只有這一層——你產品的終端使用者 nimplex 不認識（客戶自理）。
 */
const ROLE_TONE: Record<OrgRole, "info" | "ok" | "neutral"> = {
  owner: "info",
  admin: "ok",
  member: "neutral",
};

export function MembersPage() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("member");

  const members = useQuery({ queryKey: ["members"], queryFn: () => nimplex.members.list() });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["members"] });

  const add = useMutation({
    mutationFn: (v: { email: string; role: OrgRole }) => nimplex.members.add(v.email, v.role),
    onSuccess: () => {
      setEmail("");
      invalidate();
    },
  });
  const setRoleMut = useMutation({
    mutationFn: (v: { id: string; role: OrgRole }) => nimplex.members.setRole(v.id, v.role),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => nimplex.members.remove(id),
    onSuccess: invalidate,
  });

  const owners = members.data?.filter((m) => m.role === "owner") ?? [];

  return (
    <>
      <h1>Members</h1>
      <p className="lede">
        這個 organization 裡的人。owner 管帳與成員、admin 管三插槽與 key、member 唯讀＋開
        run。你產品的終端使用者不在這裡——那是你自己的 app 的事。
      </p>

      <Panel
        title="成員"
        hint="加進來的 email 用同一個信箱註冊即可登入這個 org"
        actions={
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = email.trim();
              if (trimmed && !add.isPending) add.mutate({ email: trimmed, role });
            }}
          >
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="邀請 email"
              aria-label="邀請 email"
              type="email"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as OrgRole)}
              aria-label="角色"
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
              <option value="owner">owner</option>
            </select>
            <button type="submit" className="btn" disabled={!email.trim() || add.isPending}>
              {add.isPending ? "加入中…" : "＋ 邀請"}
            </button>
          </form>
        }
      >
        <ErrorNote error={add.error ?? setRoleMut.error ?? remove.error ?? members.error} />

        {members.data?.map((m) => (
          <div key={m.id} className="keyline">
            <span className="strong">{m.email}</span>
            <Badge tone={ROLE_TONE[m.role]}>{m.role}</Badge>
            <span className="dim">加入 {m.created_at.slice(0, 10)}</span>
            <span className="spacer" />
            <select
              value={m.role}
              aria-label={`${m.email} 的角色`}
              disabled={setRoleMut.isPending}
              onChange={(e) => setRoleMut.mutate({ id: m.id, role: e.target.value as OrgRole })}
            >
              <option value="owner">owner</option>
              <option value="admin">admin</option>
              <option value="member">member</option>
            </select>
            <button
              type="button"
              className="btn danger ghost"
              disabled={remove.isPending || (m.role === "owner" && owners.length === 1)}
              onClick={() => remove.mutate(m.id)}
            >
              移除
            </button>
          </div>
        ))}
        {members.isSuccess && members.data.length === 0 ? <Empty>沒有成員。</Empty> : null}
      </Panel>
    </>
  );
}
