import type { HarnessManifest, HarnessOutput, ModelProvider } from "@nimplex/sdk";
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
  /** 帶入既有 manifest ＝ 編輯（同 slug 上傳就是覆寫）；拿內建的當範本也是走這裡 */
  initial?: HarnessManifest;
}

export function UploadHarness({ onCancel, onSubmit, pending, error, initial }: UploadHarnessProps) {
  // 表單每次開啟都是新掛載，所以 initial 只在第一次 render 用來初始化
  const init = fromManifest(initial);
  const [kind, setKind] = useState<SourceKind>(init.kind);
  const [slug, setSlug] = useState(init.slug);
  const [repo, setRepo] = useState(init.repo);
  const [ref, setRef] = useState(init.ref);
  const [pkg, setPkg] = useState(init.pkg);
  const [version, setVersion] = useState(init.version);
  const [image, setImage] = useState(init.image);
  const [command, setCommand] = useState(init.command);
  const [setup, setSetup] = useState(init.setup);
  const [provider, setProvider] = useState<ModelProvider>(init.provider);
  // manifest 的其他欄位：預設值就能跑，所以收在「進階」裡；編輯既有 harness 時直接展開
  const [advanced, setAdvanced] = useState(initial !== undefined);
  const [name, setName] = useState(init.name);
  const [description, setDescription] = useState(init.description);
  const [manifestVersion, setManifestVersion] = useState(init.manifestVersion);
  const [envText, setEnvText] = useState(init.envText);
  const [output, setOutput] = useState<HarnessOutput>(init.output);
  const [workdir, setWorkdir] = useState(init.workdir);
  const [timeoutSec, setTimeoutSec] = useState(init.timeout);

  const form: FormState = {
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
    name,
    description,
    manifestVersion,
    envText,
    output,
    workdir,
    timeout: timeoutSec,
  };
  const envParsed = parseEnvLines(envText);
  const manifest = buildManifest(form, envParsed.env);
  const parsed = harnessManifest.safeParse(manifest);
  const submittable = parsed.success && envParsed.errors.length === 0;

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
            <h2>{initial ? "Edit harness" : "Upload harness"}</h2>
            <p>
              {initial
                ? "同一個 slug 再上傳就是覆寫；改了 slug 就是另存一份。"
                : "從 Git repo、npm、容器映像，或完全自己寫的步驟建立一個 harness。"}
            </p>
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

          <button
            type="button"
            className="btn ghost"
            style={{ alignSelf: "flex-start" }}
            aria-expanded={advanced}
            onClick={() => setAdvanced((v) => !v)}
          >
            {advanced ? "▾" : "▸"} manifest 進階欄位（名稱、env、output、workdir、timeout）
          </button>

          {advanced ? (
            <>
              <Field htmlFor="uh-name" label="顯示名稱" hint="留空就用 slug">
                <input
                  id="uh-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My harness"
                />
              </Field>
              <Field htmlFor="uh-desc" label="描述" hint="選填，最多 512 字">
                <input
                  id="uh-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
              <Field htmlFor="uh-mver" label="Manifest 版本" hint="你自己的版號，跟 npm 版本無關">
                <input
                  id="uh-mver"
                  value={manifestVersion}
                  onChange={(e) => setManifestVersion(e.target.value)}
                  placeholder="1.0.0"
                />
              </Field>
              <div className="field">
                <div className="field-row">
                  <span className="field-label">額外 env</span>
                  <span className="optional">選填</span>
                </div>
                <textarea
                  id="uh-env"
                  className="editor"
                  rows={3}
                  spellCheck={false}
                  value={envText}
                  onChange={(e) => setEnvText(e.target.value)}
                  placeholder={"MY_FLAG=1\nAGENT_WORKDIR={{workdir}}"}
                />
                <span className="field-hint">
                  一行一個 KEY=VALUE，值可用 {"{{run.id}} {{model}} {{workdir}}"} 等模板變數。
                  閘道注入的那組永遠會蓋在上面——base URL 與短期票不能被改掉。
                </span>
              </div>
              <Field
                htmlFor="uh-output"
                label="Output"
                hint="harness stdout 的格式：text 整段當回覆；stream-json 逐行解析成事件"
              >
                <select
                  id="uh-output"
                  value={output}
                  onChange={(e) => setOutput(e.target.value as HarnessOutput)}
                >
                  <option value="text">text</option>
                  <option value="stream-json">stream-json</option>
                </select>
              </Field>
              <Field
                htmlFor="uh-workdir"
                label="Workdir"
                hint="沙箱裡執行 install / command 的目錄"
              >
                <input
                  id="uh-workdir"
                  value={workdir}
                  onChange={(e) => setWorkdir(e.target.value)}
                  placeholder="/workspace"
                />
              </Field>
              <Field
                htmlFor="uh-timeout"
                label="Timeout（秒）"
                hint="沙箱裡的硬性上限，壞掉的 harness 不會永遠不結束；最多 86400"
              >
                <input
                  id="uh-timeout"
                  inputMode="numeric"
                  value={timeoutSec}
                  onChange={(e) => setTimeoutSec(e.target.value)}
                  placeholder="1800"
                />
              </Field>
            </>
          ) : null}

          {envParsed.errors.length > 0 ? (
            <div className="errnote" style={{ margin: 0 }}>
              {envParsed.errors.join("\n")}
            </div>
          ) : null}
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
            disabled={!submittable || pending}
            onClick={() => submittable && onSubmit(parsed.data)}
          >
            {pending ? "上傳中…" : initial ? "Save harness" : "Upload harness"}
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
  name: string;
  description: string;
  manifestVersion: string;
  /** 一行一個 KEY=VALUE；閘道注入的那組不在這裡 */
  envText: string;
  output: HarnessOutput;
  workdir: string;
  timeout: string;
}

const EMPTY_FORM: FormState = {
  kind: "git",
  slug: "",
  repo: "",
  ref: "",
  pkg: "",
  version: "",
  image: "",
  command: "",
  setup: "",
  provider: "anthropic",
  name: "",
  description: "",
  manifestVersion: "1.0.0",
  envText: "",
  output: "text",
  workdir: "/workspace",
  timeout: "1800",
};

/**
 * 表單 → manifest。
 *
 * clone / 安裝指令是這裡「生」出來的而不是要使用者自己寫：worker 只會照著
 * install 陣列執行，source 欄位本身不會觸發任何動作。所以 GitHub 來源必須
 * 把 git clone 明確放進 install 的第一步，否則沙箱裡什麼都不會有。
 */
function buildManifest(f: FormState, extraEnv: Record<string, string>): Record<string, unknown> {
  const setupLines = f.setup
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let source: Record<string, unknown> = { kind: "inline" };
  if (f.kind === "git") {
    source = { kind: "git", repo: f.repo.trim(), ref: f.ref.trim() || "HEAD" };
  } else if (f.kind === "npm") {
    source = { kind: "npm", package: f.pkg.trim(), version: f.version.trim() || "latest" };
  } else if (f.kind === "image") {
    source = { kind: "image", image: f.image.trim() };
  }
  const generated = generatedInstall(f);
  const install = generated ? [generated, ...setupLines] : setupLines;
  const timeout = Number(f.timeout.trim());

  return {
    slug: f.slug.trim(),
    name: f.name.trim() || f.slug.trim() || "Untitled harness",
    version: f.manifestVersion.trim() || "1.0.0",
    description: f.description.trim() || undefined,
    source,
    install,
    command: f.command.trim(),
    // 使用者的 env 先放，閘道注入的那組蓋在上面：base URL 與短期票是 harness 拿到模型的唯一途徑
    env: { ...extraEnv, ...ENV_BY_PROVIDER[f.provider] },
    provider: f.provider,
    output: f.output,
    workdir: f.workdir.trim() || "/workspace",
    timeout_seconds: Number.isFinite(timeout) && f.timeout.trim() !== "" ? timeout : f.timeout,
  };
}

/** 來源決定的那一行安裝指令（git clone / npm install）；沒填來源就沒有 */
function generatedInstall(f: Pick<FormState, "kind" | "repo" | "ref" | "pkg" | "version">) {
  if (f.kind === "git" && f.repo.trim()) {
    const branch = f.ref.trim() ? ` --branch ${f.ref.trim()}` : "";
    return `git clone --depth 1${branch} ${f.repo.trim()} .`;
  }
  if (f.kind === "npm" && f.pkg.trim()) {
    return `npm install -g ${f.pkg.trim()}@${f.version.trim() || "latest"}`;
  }
  return null;
}

/** manifest → 表單（編輯既有的、或拿內建當範本）。與 buildManifest 互為反函式。 */
function fromManifest(m: HarnessManifest | undefined): FormState {
  if (!m) return EMPTY_FORM;
  const f: FormState = {
    ...EMPTY_FORM,
    slug: m.slug,
    name: m.name === m.slug ? "" : m.name,
    description: m.description ?? "",
    manifestVersion: m.version,
    command: m.command,
    provider: m.provider,
    output: m.output,
    workdir: m.workdir,
    timeout: String(m.timeout_seconds),
  };
  const src = m.source;
  if (src.kind === "git") {
    f.kind = "git";
    f.repo = src.repo;
    f.ref = src.ref === "HEAD" ? "" : src.ref;
  } else if (src.kind === "npm") {
    f.kind = "npm";
    f.pkg = src.package;
    f.version = src.version === "latest" ? "" : src.version;
  } else if (src.kind === "image") {
    f.kind = "image";
    f.image = src.image;
  } else {
    f.kind = "inline";
  }
  // 我們自動生的 clone / npm install 那行不回填成 setup，否則再上傳會重複一次
  const generated = generatedInstall(f);
  const install = generated && m.install[0] === generated ? m.install.slice(1) : m.install;
  f.setup = install.join("\n");
  // 閘道注入的那組不回填，剩下的才是使用者自己加的
  const injected = ENV_BY_PROVIDER[m.provider];
  f.envText = Object.entries(m.env)
    .filter(([k, v]) => injected[k] !== v)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  return f;
}

/** 「KEY=VALUE 一行一個」→ env；格式不對的行列成錯誤，不默默吞掉 */
function parseEnvLines(text: string): { env: Record<string, string>; errors: string[] } {
  const env: Record<string, string> = {};
  const errors: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = eq === -1 ? line : line.slice(0, eq).trim();
    if (eq === -1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push(`env：「${line}」不是 KEY=VALUE`);
      continue;
    }
    env[key] = line.slice(eq + 1).trim();
  }
  return { env, errors };
}
