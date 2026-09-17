import { useEffect, useState } from "react";

/**
 * Tally form displayed as a popup.
 *
 * Joining the waitlist is the main action. An inline form can exceed 2,000 px
 * and overwhelm the hero, hiding that action. A popup keeps our monochrome
 * button visible while the modal accommodates the full form.
 *
 * Progressive enhancement: the anchor opens tally.so/r/<id> without JavaScript;
 * when JavaScript is available, intercept clicks to open the modal.
 *
 * Set VITE_TALLY_FORM_ID in apps/site/.env to the FORM_ID from the Tally URL.
 * Missing configuration displays setup guidance instead of a broken button.
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
          if (!ready || !window.Tally) return; // Let the browser open the link normally.
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
