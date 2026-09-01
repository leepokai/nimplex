import { useState } from "react";
import { Badge, CopyCall, Empty, Field, Panel } from "../ui.tsx";

/**
 * Skills（agent 用的）：一個資料夾＋一份 SKILL.md 的指令包。
 * 定義：上傳進 org 的 skill registry，建 run 時帶 `skills: ["slug"]`，
 * supervisor 會在沙箱裡把 skill 檔放進該 harness 的 skills 目錄（如 Claude Code 的 ~/.claude/skills）。
 * 這頁目前是示意操作：registry API（/v1/skills）尚未實作。
 *
 * 注意：這裡管的是「agent 用的 skill」。「你拿來管 nimplex 的 skill」是右下角
 * 那張 AgentConnect 安裝卡——兩件事，刻意分開。
 */
type Skill = {
  slug: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
};

const SEED: Skill[] = [
  {
    slug: "code-review",
    name: "Code review",
    description: "審查 diff 的正確性與風格，輸出結構化 findings",
    version: "1.2.0",
    enabled: true,
  },
  {
    slug: "pdf-report",
    name: "PDF report",
    description: "把 markdown 產出排版成 PDF",
    version: "0.4.1",
    enabled: true,
  },
  {
    slug: "db-migrate",
    name: "DB migrate",
    description: "產生與驗證 drizzle migration",
    version: "0.9.0",
    enabled: false,
  },
];

export function SkillsPage() {
  const [skills, setSkills] = useState(SEED);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ slug: "", description: "" });

  return (
    <>
      <h1>
        Skills <Badge tone="warn">示意操作</Badge>
      </h1>
      <p className="lede">
        給 agent 掛的指令包：一個資料夾＋一份 <code>SKILL.md</code>。建 run 時帶{" "}
        <code>skills: ["slug"]</code>，supervisor 會把它放進沙箱裡該 harness 的 skills 目錄——跨
        harness 同一份 skill 直接沿用。
      </p>

      <Panel
        title="Skill registry"
        hint="registry API（/v1/skills）尚未實作；操作先走本地示意"
        actions={
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            ＋ 上傳 skill
          </button>
        }
      >
        {skills.map((s) => (
          <div key={s.slug} className="keyline">
            <span className="mono strong">{s.slug}</span>
            <span className="tag mono">v{s.version}</span>
            <span className="dim">{s.description}</span>
            <span className="spacer" />
            <Badge tone={s.enabled ? "ok" : "neutral"}>{s.enabled ? "啟用" : "停用"}</Badge>
            <button
              type="button"
              className="btn ghost"
              onClick={() =>
                setSkills((prev) =>
                  prev.map((x) => (x.slug === s.slug ? { ...x, enabled: !x.enabled } : x)),
                )
              }
            >
              {s.enabled ? "停用" : "啟用"}
            </button>
            <button
              type="button"
              className="btn danger ghost"
              onClick={() => setSkills((prev) => prev.filter((x) => x.slug !== s.slug))}
            >
              移除
            </button>
            <CopyCall snippet={`skills: ["${s.slug}"]`} label="複製掛載設定" />
          </div>
        ))}
        {skills.length === 0 ? <Empty>還沒有 skill。</Empty> : null}

        {adding ? (
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              const slug = draft.slug.trim();
              if (!slug) return;
              setSkills((prev) => [
                ...prev,
                {
                  slug,
                  name: slug,
                  description: draft.description.trim() || "（未填描述）",
                  version: "0.1.0",
                  enabled: true,
                },
              ]);
              setDraft({ slug: "", description: "" });
              setAdding(false);
            }}
          >
            <Field htmlFor="sk-slug" label="Slug">
              <input
                id="sk-slug"
                value={draft.slug}
                onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value }))}
                placeholder="my-skill"
              />
            </Field>
            <Field htmlFor="sk-desc" label="描述">
              <input
                id="sk-desc"
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </Field>
            <div className="form-actions">
              <button type="submit" className="btn">
                建立
              </button>
              <button type="button" className="btn ghost" onClick={() => setAdding(false)}>
                取消
              </button>
            </div>
          </form>
        ) : null}
      </Panel>
    </>
  );
}
