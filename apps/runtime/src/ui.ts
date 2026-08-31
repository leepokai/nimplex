// 開發用測試頁——不是 console。console 走 contracts 對 mock/真後端，這頁只為了肉眼驗證 runtime。
export const UI = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nimplex runtime dev</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, "PingFang TC", sans-serif; max-width: 780px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
  fieldset { border: 1px solid #8884; border-radius: 8px; margin-bottom: 1rem; }
  input, button, textarea { font: inherit; padding: 0.35rem 0.6rem; }
  input { width: 10rem; }
  #log { border: 1px solid #8884; border-radius: 8px; padding: 0.8rem; height: 420px; overflow-y: auto; font-size: 0.88rem; }
  .ev { margin-bottom: 0.5rem; padding-left: 0.6rem; border-left: 3px solid #8886; white-space: pre-wrap; word-break: break-word; }
  .ev.assistant_text { border-color: #0E8074; }
  .ev.tool_call, .ev.tool_result { border-color: #D96F0E; font-family: ui-monospace, monospace; font-size: 0.8rem; }
  .ev.budget_exceeded { border-color: #B4483C; color: #B4483C; font-weight: 700; }
  .ev.error { border-color: #B4483C; }
  .tag { opacity: 0.55; font-size: 0.72rem; margin-right: 0.4rem; }
  #meter { height: 8px; background: #8883; border-radius: 4px; margin: 0.5rem 0 1rem; overflow: hidden; }
  #meter div { height: 100%; width: 0%; background: #0E8074; transition: width 0.3s; }
  #meter.hot div { background: #B4483C; }
  #spend { font-variant-numeric: tabular-nums; font-size: 0.85rem; opacity: 0.8; }
  #composer { display: flex; gap: 0.5rem; margin-top: 1rem; }
  #composer textarea { flex: 1; height: 3.2rem; }
</style>
</head>
<body>
<h1>nimplex runtime <small style="font-size:0.5em;opacity:0.6">dev 測試頁</small></h1>

<fieldset>
  <legend>建立 session</legend>
  <label>end_user <input id="endUser" value="demo-user-1"></label>
  <label>預算 USD <input id="budget" type="number" step="0.01" value="0.50"></label>
  <label>model <input id="model" value="claude-opus-5" style="width:13rem"></label>
  <button id="create">建立</button>
  <span id="sid" style="font-family:monospace;font-size:0.8rem"></span>
</fieldset>

<div id="spend">尚未建立 session</div>
<div id="meter"><div></div></div>
<div id="log"></div>

<div id="composer">
  <textarea id="input" placeholder="例：在 /workspace 寫一個 python 腳本印出前 20 個質數，然後執行它"></textarea>
  <button id="send" disabled>送出</button>
</div>

<script>
let sessionId = null;
const log = document.getElementById("log");
const meter = document.getElementById("meter");

function addEvent(ev) {
  const div = document.createElement("div");
  div.className = "ev " + ev.type;
  let body = "";
  if (ev.type === "assistant_text") body = ev.text;
  else if (ev.type === "user_message") body = "🧑 " + ev.text;
  else if (ev.type === "tool_call") body = "→ " + ev.tool + " " + JSON.stringify(ev.input);
  else if (ev.type === "tool_result") body = "← " + (ev.output ?? "").slice(0, 600);
  else if (ev.type === "budget_exceeded") body = "⚡ 斷電：花費 $" + ev.spent_usd.toFixed(4) + " ≥ 上限 $" + ev.budget_usd.toFixed(2) + "，run 已終止";
  else if (ev.type === "usage") { updateMeter(ev.spent_usd, ev.budget_usd); return; }
  else body = JSON.stringify(ev);
  div.innerHTML = '<span class="tag">' + ev.type + "</span>" + body.replace(/</g, "&lt;");
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function updateMeter(spent, budget) {
  const pct = Math.min(100, (spent / budget) * 100);
  meter.querySelector("div").style.width = pct + "%";
  meter.classList.toggle("hot", pct > 80);
  document.getElementById("spend").textContent =
    "花費 $" + spent.toFixed(4) + " / 上限 $" + budget.toFixed(2) + "（" + pct.toFixed(1) + "%）";
}

document.getElementById("create").onclick = async () => {
  const res = await fetch("/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      end_user: document.getElementById("endUser").value,
      budget_usd: Number(document.getElementById("budget").value),
      model: document.getElementById("model").value,
      instructions: "",
    }),
  });
  const data = await res.json();
  sessionId = data.id;
  document.getElementById("sid").textContent = sessionId;
  document.getElementById("send").disabled = false;
  updateMeter(0, Number(document.getElementById("budget").value));
  const es = new EventSource("/v1/sessions/" + sessionId + "/events");
  es.onmessage = (msg) => addEvent(JSON.parse(msg.data));
};

document.getElementById("send").onclick = async () => {
  const input = document.getElementById("input");
  const text = input.value.trim();
  if (!text || !sessionId) return;
  input.value = "";
  const res = await fetch("/v1/sessions/" + sessionId + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) addEvent({ type: "error", message: "HTTP " + res.status + " " + (await res.text()) });
};
</script>
</body>
</html>`;
