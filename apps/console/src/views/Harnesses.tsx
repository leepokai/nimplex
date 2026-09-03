import type { HarnessManifest, HarnessSummary } from "@nimplex/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { nimplex, queryKeys } from "../client.ts";
import { Badge, Code, CopyCall, Empty, ErrorNote, Panel } from "../ui.tsx";
import { omit } from "../util.ts";
import { UploadHarness } from "./UploadHarness.tsx";

export function HarnessesPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: queryKeys.harnesses, queryFn: () => nimplex.harness.list() });
  // null ＝ 關閉；{} ＝ 新建；{ initial } ＝ 編輯既有的／拿內建當範本覆寫
  const [editor, setEditor] = useState<{ initial?: HarnessManifest } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: (manifest: HarnessManifest) => nimplex.harness.upload(manifest),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.harnesses });
      setEditor(null);
    },
  });
  const remove = useMutation({
    mutationFn: (slug: string) => nimplex.harness.delete(slug),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.harnesses }),
  });

  const mine = list.data?.filter((h) => !h.builtin) ?? [];
  const builtin = list.data?.filter((h) => h.builtin) ?? [];

  return (
    <>
      <h1>Harness</h1>
      <p className="lede">
        harness 是<strong>資料不是程式碼</strong>。我們提供幾個現成的，你也可以從自己的 GitHub
        repo、npm 套件或容器映像上傳；用同一個名字上傳就會覆寫內建版本（只在你的 org 生效）。
      </p>

      <Panel
        title="從你自己的來源上傳"
        hint="公開 repo 現在就能用；私有 repo 需要先連接 GitHub"
        actions={
          <button type="button" className="btn primary" onClick={() => setEditor({})}>
            + Upload harness
          </button>
        }
      >
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="conn">
            <div className="body">
              <div className="t">GitHub</div>
              <div className="d">
                <strong>公開 repo 已經可用</strong> —— 直接在上傳視窗選 GitHub 貼網址即可。 私有
                repo 還不行：沙箱裡的 clone 需要一組憑證，而我們目前只有 model provider
                的保險庫，還沒有 Git 憑證這一類。要開這條的話得補後端（OAuth app + 憑證表 + clone
                時注入），不是前端加一顆按鈕就會通。
              </div>
            </div>
            <button type="button" className="btn" disabled title="需要後端支援，尚未實作">
              連接帳號
            </button>
          </div>
        </div>
      </Panel>

      <Panel
        title="註冊表"
        hint={`${mine.length} 個你的 · ${builtin.length} 個內建`}
        actions={<CopyCall snippet="await nimplex.harness.list()" label="複製 list 呼叫" />}
      >
        <ErrorNote error={list.error} />
        {list.isPending ? <Empty>載入中…</Empty> : null}
        {list.data?.length === 0 ? <Empty>註冊表是空的。</Empty> : null}
        {list.data?.map((h) => (
          <div key={h.slug} className="row-group">
            <div className="row">
              <button
                type="button"
                className="row-main"
                onClick={() => setExpanded((cur) => (cur === h.slug ? null : h.slug))}
              >
                <span className="chev">{expanded === h.slug ? "▾" : "▸"}</span>
                <span className="mono strong">{h.slug}</span>
                {h.builtin ? (
                  <Badge tone="neutral">builtin</Badge>
                ) : (
                  <Badge tone="ok">★ 你的</Badge>
                )}
                <span className="dim">{h.name}</span>
                <span className="spacer" />
                <span className="tag">{h.provider}</span>
                <span className="tag">{h.source.kind}</span>
              </button>
              <button
                type="button"
                className="btn ghost"
                title={
                  h.builtin
                    ? "以內建版本為範本，存成你 org 自己的覆寫"
                    : "改 manifest 再上傳（同 slug 覆寫）"
                }
                onClick={() => setEditor({ initial: stripMeta(h) })}
              >
                {h.builtin ? "覆寫" : "編輯"}
              </button>
              {h.builtin ? null : (
                <button
                  type="button"
                  className="btn danger ghost"
                  onClick={() => remove.mutate(h.slug)}
                  disabled={remove.isPending}
                >
                  刪除
                </button>
              )}
            </div>
            {expanded === h.slug ? (
              <div className="row-detail">
                <Code>{JSON.stringify(stripMeta(h), null, 2)}</Code>
                <CopyCall
                  snippet={`await nimplex.harness.upload(${JSON.stringify(stripMeta(h), null, 2)})`}
                  label="以此為範本複製"
                />
              </div>
            ) : null}
          </div>
        ))}
      </Panel>

      {editor ? (
        <UploadHarness
          initial={editor.initial}
          pending={upload.isPending}
          error={upload.error}
          onCancel={() => setEditor(null)}
          onSubmit={(m) => upload.mutate(m)}
        />
      ) : null}
    </>
  );
}

/** 回應多了 id/builtin/created_at，回填成 manifest 時要拿掉。 */
function stripMeta(row: HarnessSummary): HarnessManifest {
  return omit(row, ["id", "builtin", "created_at"]);
}
