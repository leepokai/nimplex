import type { HarnessManifest, ModelProvider } from "@nimplex/sdk";
import { harnessManifest } from "@nimplex/sdk";
import { useEffect, useState } from "react";
import { CopyCall, ErrorNote, Field } from "../ui.tsx";

type SourceKind = "git" | "npm" | "image" | "inline";

const SOURCES: { kind: SourceKind; title: string; desc: string; glyph: React.ReactNode }[] = [
  {
    kind: "git",
    title: "GitHub",
    desc: "Clone from a Git repository",
    glyph: (
      <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
    ),
  },
  {
    kind: "npm",
    title: "npm",
    desc: "Install from the npm registry",
    glyph: (
      <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M0 3h16v9H8v1.5H4.5V12H0V3Zm1.5 1.5v6H4V6h1.5v4.5H7v-6H1.5Zm7 0v6H10V6h1.5v4.5H13V6h1.5v4.5H16v-6H8.5Z" />
      </svg>
    ),
  },
  {
    kind: "image",
    title: "Container image",
    desc: "The harness is already baked in",
    glyph: (
      <svg
        width="17"
        height="17"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        aria-hidden="true"
      >
        <path d="M8 1.6 14 5v6l-6 3.4L2 11V5l6-3.4Z" />
        <path d="M2 5l6 3.4L14 5M8 8.4v6" />
      </svg>
    ),
  },
  {
    kind: "inline",
    title: "Inline",
    desc: "No external source — you write every step",
    glyph: (
      <svg
        width="17"
        height="17"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" />
      </svg>
    ),
  },
];

/** 閘道注入的 env：使用者不用自己寫，寫錯 harness 就拿不到 base URL */
const ENV_BY_PROVIDER: Record<ModelProvider, Record<string, string>> = {
  anthropic: {
    ANTHROPIC_BASE_URL: "{{gateway.anthropic}}",
    ANTHROPIC_API_KEY: "{{run.token}}",
  },
  openai: { OPENAI_BASE_URL: "{{gateway.openai}}", OPENAI_API_KEY: "{{run.token}}" },
  openrouter: { OPENAI_BASE_URL: "{{gateway.openrouter}}", OPENAI_API_KEY: "{{run.token}}" },
};

export interface UploadHarnessProps {
  onCancel: () => void;
  onSubmit: (manifest: HarnessManifest) => void;
  pending: boolean;
  error: unknown;
}

export function UploadHarness({ onCancel, onSubmit, pending, error }: UploadHarnessProps) {
  const [kind, setKind] = useState<SourceKind>("git");
  const [slug, setSlug] = useState("");
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("");
  const [pkg, setPkg] = useState("");
  const [version, setVersion] = useState("");
  const [image, setImage] = useState("");
  const [command, setCommand] = useState("");
  const [setup, setSetup] = useState("");
  const [provider, setProvider] = useState<ModelProvider>("anthropic");

  const manifest = buildManifest({
    kind,
    slug,
    repo,
    ref,
    pkg,
    version,
    image,
    command,
    setup,
    provider,
  });
  const parsed = harnessManifest.safeParse(manifest);

  // Esc 關閉。背景點擊關閉被拿掉了：那需要在 div 上掛 click handler，
  // 對鍵盤與螢幕閱讀器都不是真的可及路徑；關閉鈕＋Esc 才是。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Upload harness">
        <header className="modal-head">
          <div>
            <h2>Upload harness</h2>
            <p>從 Git repo、npm、容器映像，或完全自己寫的步驟建立一個 harness。</p>
          </div>
          <button type="button" className="modal-x" onClick={onCancel} aria-label="關閉">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <div>
            <span className="field-label">Source type</span>
            <div className="src-grid" style={{ marginTop: 7 }}>
              {SOURCES.map((s) => (
                <button
                  key={s.kind}
                  type="button"
                  className={`src${kind === s.kind ? " on" : ""}`}
                  onClick={() => setKind(s.kind)}
                >
                  <span className="glyph">{s.glyph}</span>
                  <span>
                    <span className="t">{s.title}</span>
                    <span className="d">{s.desc}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <Field
            htmlFor="uh-slug"
            label="Harness name"
            hint="小寫英數與連字號；跟內建同名就會覆寫它"
          >
            <input
              id="uh-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="my-harness"
            />
          </Field>

          {kind === "git" ? (
            <>
              <Field htmlFor="uh-repo" label="Repository URL">
                <input
                  id="uh-repo"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="https://github.com/username/repo"
                />
              </Field>
              <Field
                htmlFor="uh-ref"
                label="Git ref"
                hint="分支或標籤。留空就用預設分支。私有 repo 需要先連接 GitHub。"
              >
                <input
                  id="uh-ref"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  placeholder="main"
                />
              </Field>
            </>
          ) : null}

          {kind === "npm" ? (
            <>
              <Field htmlFor="uh-pkg" label="Package">
                <input
                  id="uh-pkg"
                  value={pkg}
                  onChange={(e) => setPkg(e.target.value)}
                  placeholder="@anthropic-ai/claude-code"
                />
              </Field>
              <Field htmlFor="uh-ver" label="Version" hint="留空就用 latest">
                <input
                  id="uh-ver"
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  placeholder="latest"
                />
              </Field>
            </>
          ) : null}

          {kind === "image" ? (
            <Field htmlFor="uh-img" label="Image" hint="沙箱直接用這個映像開箱">
              <input
                id="uh-img"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="ghcr.io/you/agent:latest"
              />
            </Field>
          ) : null}

          <Field
            htmlFor="uh-cmd"
            label="Run command"
            hint="{{prompt}} {{model}} 會在開箱時展開；代入的值會被 shell 單引號包起來，不要自己補引號"
          >
            <input
              id="uh-cmd"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="my-agent run {{prompt}} --model {{model}}"
            />
          </Field>

          <div className="field">
            <div className="field-row">
              <span className="field-label">Setup commands</span>
              <span className="optional">選填</span>
            </div>
            <textarea
              id="uh-setup"
              className="editor"
              rows={4}
              spellCheck={false}
              value={setup}
              onChange={(e) => setSetup(e.target.value)}
              placeholder={"npm install\nnpm run build"}
            />
            <span className="field-hint">
              clone／安裝之後依序執行，一行一個指令。
              {kind === "git" ? " clone 指令我們會自動加在最前面。" : null}
            </span>
          </div>

          <Field
            htmlFor="uh-provider"
            label="Model provider"
            hint="決定注入哪一組 base URL 與短期票 —— 這是 harness 拿得到模型的唯一途徑"
          >
            <select
              id="uh-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value as ModelProvider)}
            >
              <option value="anthropic">anthropic</option>
              <option value="openai">openai</option>
              <option value="openrouter">openrouter</option>
            </select>
          </Field>

          <div className="oknote" style={{ margin: 0 }}>
            自動注入：{Object.keys(ENV_BY_PROVIDER[provider]).join(" · ")}
          </div>

          {parsed.success ? null : slug || command ? (
            <div className="errnote" style={{ margin: 0 }}>
              {parsed.error.issues
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                .join("\n")}
            </div>
          ) : null}
          <ErrorNote error={error} />
        </div>

        <footer className="modal-foot">
          {parsed.success ? (
            <CopyCall
              snippet={`await nimplex.harness.upload(${JSON.stringify(parsed.data, null, 2)})`}
            />
          ) : null}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!parsed.success || pending}
            onClick={() => parsed.success && onSubmit(parsed.data)}
          >
            {pending ? "上傳中…" : "Upload harness"}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface FormState {
  kind: SourceKind;
  slug: string;
  repo: string;
  ref: string;
  pkg: string;
  version: string;
  image: string;
  command: string;
  setup: string;
  provider: ModelProvider;
}

/**
 * 表單 → manifest。
 *
 * clone / 安裝指令是這裡「生」出來的而不是要使用者自己寫：worker 只會照著
 * install 陣列執行，source 欄位本身不會觸發任何動作。所以 GitHub 來源必須
 * 把 git clone 明確放進 install 的第一步，否則沙箱裡什麼都不會有。
 */
function buildManifest(f: FormState): Record<string, unknown> {
  const setupLines = f.setup
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let source: Record<string, unknown> = { kind: "inline" };
  const install: string[] = [];

  if (f.kind === "git") {
    source = { kind: "git", repo: f.repo.trim(), ref: f.ref.trim() || "HEAD" };
    const branch = f.ref.trim() ? ` --branch ${f.ref.trim()}` : "";
    if (f.repo.trim()) install.push(`git clone --depth 1${branch} ${f.repo.trim()} .`);
  } else if (f.kind === "npm") {
    const version = f.version.trim() || "latest";
    source = { kind: "npm", package: f.pkg.trim(), version };
    if (f.pkg.trim()) install.push(`npm install -g ${f.pkg.trim()}@${version}`);
  } else if (f.kind === "image") {
    source = { kind: "image", image: f.image.trim() };
  }
  install.push(...setupLines);

  return {
    slug: f.slug.trim(),
    name: f.slug.trim() || "Untitled harness",
    version: "1.0.0",
    source,
    install,
    command: f.command.trim(),
    env: ENV_BY_PROVIDER[f.provider],
    provider: f.provider,
    output: "text",
    workdir: "/workspace",
    timeout_seconds: 1800,
  };
}
