import { useEffect, useState } from "react";

/**
 * Tally 表單，用 **popup** 而不是 inline embed。
 *
 * 為什麼不 inline：這頁的主要動作就是 join waitlist。整份表單 inline 嵌進來會撐到
 * 2000px 以上，把 hero 整個吃掉，主要動作反而看不見。popup 讓按鈕維持我們自己的
 * 黑白樣式，表單在 modal 裡跑完整長度。
 *
 * 漸進增強：按鈕本體是一個指向 tally.so/r/<id> 的 <a>，沒有 JS 也能報名；
 * 有 JS 時攔截點擊改開 modal。
 *
 * 設定：把 https://tally.so/r/<FORM_ID> 的 FORM_ID 放進 apps/site/.env 的
 * VITE_TALLY_FORM_ID。沒設的話顯示設定指引，而不是一個壞掉的按鈕。
 */

const FORM_ID = import.meta.env.VITE_TALLY_FORM_ID as string | undefined;
const EMBED_SCRIPT = "https://tally.so/widgets/embed.js";

interface TallyPopupOptions {
  layout?: "default" | "modal";
  width?: number;
  hideTitle?: boolean;
  overlay?: boolean;
  onSubmit?: () => void;
}
declare global {
  interface Window {
    Tally?: { openPopup: (formId: string, options?: TallyPopupOptions) => void };
  }
}

export function Waitlist({ id, label = "Join the waitlist" }: { id?: string; label?: string }) {
  const [ready, setReady] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!FORM_ID) return;
    if (window.Tally) {
      setReady(true);
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${EMBED_SCRIPT}"]`);
    const script = existing ?? document.createElement("script");
    const onLoad = () => setReady(Boolean(window.Tally));
    script.addEventListener("load", onLoad);
    if (!existing) {
      script.src = EMBED_SCRIPT;
      script.async = true;
      document.body.appendChild(script);
    }
    return () => script.removeEventListener("load", onLoad);
  }, []);

  if (!FORM_ID) {
    return (
      <div className="waitlist" id={id}>
        <div className="waitlist-setup">
          <strong>Waitlist 表單尚未設定</strong>
          <ol>
            <li>
              到 <a href="https://tally.so">tally.so</a> 開一個表單
            </li>
            <li>
              從分享網址 <code>https://tally.so/r/&lt;FORM_ID&gt;</code> 取出 FORM_ID
            </li>
            <li>
              寫進 <code>apps/site/.env</code>：<code>VITE_TALLY_FORM_ID=&lt;FORM_ID&gt;</code>
            </li>
          </ol>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="waitlist" id={id}>
        <p className="waitlist-done">You're on the list. We'll be in touch directly.</p>
      </div>
    );
  }

  return (
    <div className="waitlist" id={id}>
      <a
        className="btn btn-primary"
        href={`https://tally.so/r/${FORM_ID}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          if (!ready || !window.Tally) return; // 讓瀏覽器照常開新分頁
          event.preventDefault();
          window.Tally.openPopup(FORM_ID, {
            layout: "modal",
            width: 540,
            hideTitle: true,
            overlay: true,
            onSubmit: () => setSubmitted(true),
          });
        }}
      >
        {label}
      </a>
    </div>
  );
}
