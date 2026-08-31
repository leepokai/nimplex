import { useQuery } from "@tanstack/react-query";
import { nimplex, queryKeys } from "../client.ts";
import { Badge, Code, CopyCall, Empty, ErrorNote, Panel } from "../ui.tsx";

const PORT_SNIPPET = `import { registerSandboxProvider } from "@nimplex/sandbox";

registerSandboxProvider({
  backendId: "my-cloud",
  unavailableReason: () => (process.env.MY_CLOUD_KEY ? null : "缺少 MY_CLOUD_KEY"),

  async create(args) {
    const box = await myCloud.boxes.create({ image: args.image, env: args.environment });
    return session({
      version: 1,
      backendId: "my-cloud",
      providerState: { boxId: box.id },   // ← 只有這裡是你家的東西
      workdir: args.workdir ?? "/workspace",
      environment: args.environment ?? {},
    });
  },

  // state 可序列化 → 換一個 worker 程序也接得回來把它砍掉
  async resume(state) { return session(state); },
  async delete(state) { await myCloud.boxes.kill(state.providerState.boxId); },
});`;

export function SandboxProvidersPage() {
  const list = useQuery({
    queryKey: queryKeys.sandboxProviders,
    queryFn: () => nimplex.sandbox.listProviders(),
  });

  return (
    <>
      <h1>Sandbox provider</h1>
      <p className="lede">
        agent 的電腦跑在哪裡。建 run 時指定 <code>sandbox.provider</code>，其他兩格完全不用改。
        沒接上的 provider 會在<strong>建立 run 當下</strong>就被擋掉，而不是跑到一半才炸。
      </p>

      <Panel
        title="可用的 provider"
        actions={
          <CopyCall snippet="await nimplex.sandbox.listProviders()" label="複製 list 呼叫" />
        }
      >
        <ErrorNote error={list.error} />
        {list.isPending ? <Empty>載入中…</Empty> : null}
        <div className="cards">
          {list.data?.map((p) => (
            <div key={p.id} className={`card${p.available ? "" : " off"}`}>
              <div className="card-head">
                <span className="mono strong">{p.id}</span>
                {p.available ? <Badge tone="ok">可用</Badge> : <Badge tone="warn">未就緒</Badge>}
              </div>
              {p.unavailable_reason ? (
                <p className="card-body dim">{p.unavailable_reason}</p>
              ) : (
                <p className="card-body dim">已就緒，可直接指定。</p>
              )}
              <CopyCall snippet={`sandbox: { provider: "${p.id}" }`} label="複製 sandbox 設定" />
            </div>
          ))}
        </div>
      </Panel>

      <Panel
        title="接自己的一家"
        hint="介面形狀對齊 OpenAI Agents SDK 的 SandboxClient：session state 可序列化、可跨程序 resume"
      >
        <p className="lede small">
          最關鍵的一條是 <code>resume(state)</code>：nimplex 的 worker
          無狀態、隨時可死，硬殺沙箱不能靠記憶體裡的 handle。state 寫進{" "}
          <code>runs.sandbox_state</code>，任何一個 worker 讀到都能接回去銷毀。
        </p>
        <Code>{PORT_SNIPPET}</Code>
      </Panel>
    </>
  );
}
