import { CaretUpDownIcon, CheckIcon, PlusIcon } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { currentOrgId, nimplex, queryKeys, switchOrg } from "./client.ts";

/**
 * Topbar 的 organization 切換器。
 * 選擇存 localStorage，切換走整頁重載——所有 query 與 x-nimplex-org header 一起重建，
 * 不用追著每個 view 清快取。
 */
export function OrgSwitcher() {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const orgs = useQuery({ queryKey: queryKeys.orgs, queryFn: () => nimplex.orgs.list() });

  const create = useMutation({
    mutationFn: (orgName: string) => nimplex.orgs.create(orgName),
    onSuccess: (org) => switchOrg(org.id),
  });

  // 存的 org 已不存在（例如指到別台 DB）→ 退回 default org 自救
  useEffect(() => {
    if (!orgs.data || !currentOrgId) return;
    if (!orgs.data.some((o) => o.id === currentOrgId)) switchOrg(null);
  }, [orgs.data]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = orgs.data?.find((o) => o.id === currentOrgId) ?? orgs.data?.[0] ?? null;

  return (
    <div className="org-switcher" ref={rootRef}>
      <button
        type="button"
        className="org-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current?.name ?? "…"}
        <span className="plan">BYOK</span>
        <CaretUpDownIcon size={13} weight="bold" />
      </button>

      {open ? (
        <div className="org-menu" role="listbox" aria-label="切換 organization">
          {orgs.data?.map((o) => (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={o.id === current?.id}
              className={`org-item${o.id === current?.id ? " active" : ""}`}
              onClick={() => {
                setOpen(false);
                if (o.id !== current?.id) switchOrg(o.id);
              }}
            >
              <span className="org-name">{o.name}</span>
              {o.id === current?.id ? <CheckIcon size={14} weight="bold" /> : null}
            </button>
          ))}

          <div className="org-menu-sep" />

          {creating ? (
            <form
              className="org-create"
              onSubmit={(e) => {
                e.preventDefault();
                const trimmed = name.trim();
                if (trimmed && !create.isPending) create.mutate(trimmed);
              }}
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="組織名稱"
                aria-label="新組織名稱"
              />
              <button type="submit" className="btn" disabled={!name.trim() || create.isPending}>
                {create.isPending ? "建立中…" : "建立"}
              </button>
            </form>
          ) : (
            <button type="button" className="org-item" onClick={() => setCreating(true)}>
              <PlusIcon size={14} weight="bold" />
              <span className="org-name">新增 organization</span>
            </button>
          )}
          {create.isError ? <div className="org-error">建立失敗，再試一次</div> : null}
        </div>
      ) : null}
    </div>
  );
}
