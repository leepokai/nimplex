import type { SkillManifestInput, SkillResponse } from "@nimplex/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { nimplex, queryKeys } from "../client.ts";
import { Badge, Code, CopyCall, Empty, ErrorNote, Field, Panel } from "../ui.tsx";
import { omit } from "../util.ts";

/**
 * Skills（agent 用的）：一個資料夾＋一份 SKILL.md 的指令包，存在 org 的 registry（/v1/skills）。
 * 建 run 時帶 `skills: ["slug"]` 把它放進沙箱裡該 harness 的 skills 目錄——這段注入路徑還沒接，
 * 這頁先把 registry 本身做真。
 *
 * 注意：這裡管的是「agent 用的 skill」。「你拿來管 nimplex 的 skill」是右下角
 * 那張 AgentConnect 安裝卡——兩件事，刻意分開。
 */
const SKILL_TEMPLATE = `---
name: my-skill
description: 一句話說這個 skill 什麼時候該被用
---

# my-skill

給 agent 的指令寫在這裡。
`;

export function SkillsPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: queryKeys.skills, queryFn: () => nimplex.skills.list() });
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: queryKeys.skills });
  const upload = useMutation({
    mutationFn: (manifest: SkillManifestInput) => nimplex.skills.upload(manifest),
    onSuccess: () => {
      invalidate();
      setAdding(false);
    },
  });
  const toggle = useMutation({
    mutationFn: (s: SkillResponse) =>
      nimplex.skills.upload({ ...stripMeta(s), enabled: !s.enabled }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (slug: string) => nimplex.skills.delete(slug),
    onSuccess: invalidate,
  });

  return (
    <>
      <h1>Skills</h1>
      <p className="lede">
        給 agent 掛的指令包：一個資料夾＋一份 <code>SKILL.md</code>。上傳進 org 的 registry， 跨
        harness 同一份 skill 直接沿用。
      </p>

      <Panel
        title="Skill registry"
        hint="已落地：/v1/skills（PUT 冪等覆寫）。建 run 時的 skills: [slug] 沙箱注入路徑是下一步"
        actions={
          <>
            <CopyCall snippet="await nimplex.skills.list()" label="複製 list 呼叫" />
            <button type="button" className="btn" onClick={() => setAdding(true)}>
              ＋ 上傳 skill
            </button>
          </>
        }
      >
        <ErrorNote error={list.error ?? toggle.error ?? remove.error} />
        {list.isPending ? <Empty>載入中…</Empty> : null}
        {list.data?.map((s) => (
          <div key={s.slug} className="row-group">
            <div className="row">
              <button
                type="button"
                className="row-main"
                onClick={() => setExpanded((cur) => (cur === s.slug ? null : s.slug))}
              >
                <span className="chev">{expanded === s.slug ? "▾" : "▸"}</span>
                <span className="mono strong">{s.slug}</span>
                <span className="tag mono">v{s.version}</span>
                <span className="dim">{s.description || s.name}</span>
                <span className="spacer" />
                <span className="dim">{Object.keys(s.files).length} 個檔案</span>
                <Badge tone={s.enabled ? "ok" : "neutral"}>{s.enabled ? "啟用" : "停用"}</Badge>
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={toggle.isPending}
                onClick={() => toggle.mutate(s)}
              >
                {s.enabled ? "停用" : "啟用"}
              </button>
              <button
                type="button"
                className="btn danger ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate(s.slug)}
              >
                移除
              </button>
              <CopyCall snippet={`await nimplex.skills.get("${s.slug}")`} label="複製 get 呼叫" />
            </div>
            {expanded === s.slug ? (
              <div className="row-detail">
                <Code>{s.files["SKILL.md"] ?? "（沒有 SKILL.md）"}</Code>
                <CopyCall
                  snippet={`await nimplex.skills.upload(${JSON.stringify(stripMeta(s), null, 2)})`}
                  label="以此為範本複製"
                />
              </div>
            ) : null}
          </div>
        ))}
        {list.data?.length === 0 && !adding ? (
          <Empty>還沒有 skill。上傳一份 SKILL.md 就是一個 skill。</Empty>
        ) : null}

        {adding ? (
          <SkillForm
            pending={upload.isPending}
            error={upload.error}
            onCancel={() => setAdding(false)}
            onSubmit={(m) => upload.mutate(m)}
          />
        ) : null}
      </Panel>
    </>
  );
}

function SkillForm({
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (manifest: SkillManifestInput) => void;
}) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("0.1.0");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState(SKILL_TEMPLATE);

  return (
    <form
      className="form-grid"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = slug.trim();
        if (!trimmed || pending) return;
        onSubmit({
          slug: trimmed,
          name: name.trim() || trimmed,
          version: version.trim() || "0.1.0",
          description: description.trim(),
          files: { "SKILL.md": content },
        });
      }}
    >
      <Field htmlFor="sk-slug" label="Slug" hint="小寫英數與連字號；同名上傳就是覆寫">
        <input
          id="sk-slug"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="my-skill"
        />
      </Field>
      <Field htmlFor="sk-name" label="名稱">
        <input
          id="sk-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My skill"
        />
      </Field>
      <Field htmlFor="sk-version" label="版本">
        <input id="sk-version" value={version} onChange={(e) => setVersion(e.target.value)} />
      </Field>
      <Field htmlFor="sk-desc" label="描述">
        <input id="sk-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field
        htmlFor="sk-content"
        label="SKILL.md"
        hint="這份檔案就是 skill 的本體；其他附檔用 SDK 的 files 帶"
      >
        <textarea
          id="sk-content"
          className="editor"
          rows={10}
          spellCheck={false}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </Field>
      <ErrorNote error={error} />
      <div className="form-actions">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "上傳中…" : "上傳"}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

/** 回應多了 id / created_at / updated_at，回填成 manifest 時要拿掉。 */
function stripMeta(row: SkillResponse): SkillManifestInput {
  return omit(row, ["id", "created_at", "updated_at"]);
}
