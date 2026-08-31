import { useState } from "react";

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "ok" | "warn" | "danger" | "neutral" | "info";
  children: React.ReactNode;
}) {
  return (
    <span className={`badge b-${tone}`}>
      <span className="dot" />
      {children}
    </span>
  );
}

export function Panel({
  title,
  hint,
  actions,
  children,
}: {
  title: string;
  hint?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>{title}</h2>
          {hint ? <p className="hint">{hint}</p> : null}
        </div>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Field({
  htmlFor,
  label,
  hint,
  children,
}: {
  /** 對應控制項的 id：顯式關聯，而不是靠 label 包住控制項的隱式關聯 */
  htmlFor: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

/**
 * Console 的每一個會改狀態的操作，旁邊都要能看到「它剛剛做了什麼」。
 * 副作用是文件永遠不會過期——因為它是從真的呼叫產生的。
 */
export function CopyCall({
  snippet,
  label = "複製 SDK 呼叫",
}: {
  snippet: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`copycall${copied ? " copied" : ""}`}
      title={snippet}
      onClick={() => {
        void navigator.clipboard?.writeText(snippet);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
    >
      <span className="glyph">{copied ? "✓" : "⧉"}</span>
      {copied ? "已複製" : label}
    </button>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return <div className="errnote">{message}</div>;
}

export function Code({ children }: { children: string }) {
  return (
    <pre className="code">
      <code>{children}</code>
    </pre>
  );
}
