import { useEffect, useRef } from "react";
import { useReducedMotion } from "../lib/useReducedMotion.ts";

type Node_ = {
  x: number;
  y: number;
  size: number;
  speed: number;
  alpha: number;
  routing: boolean;
  vx: number;
  vy: number;
};

/**
 * 背景訊號場：小方塊緩慢上飄，偶爾一顆「被路由出去」（往右上加速並拖出尾跡）。
 * 這是整頁唯一的環境動畫，所以它必須便宜：捲出視口就停畫、背景分頁停畫、
 * reduced-motion 只畫一張靜態幀。
 */
export function SignalField({ className = "" }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let raf = 0;
    let nodes: Node_[] = [];
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const seed = (w: number, h: number): Node_ => ({
      x: Math.random() * w,
      y: Math.random() * h,
      size: (Math.random() < 0.82 ? 1 : 2) * dpr,
      speed: (0.05 + Math.random() * 0.18) * dpr,
      alpha: 0.14 + Math.random() * 0.4,
      routing: false,
      vx: 0,
      vy: 0,
    });

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = canvas;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      nodes = Array.from({ length: Math.round((w * h) / 11000) }, () =>
        seed(canvas.width, canvas.height),
      );
    };

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const n of nodes) {
        ctx.globalAlpha = n.routing ? Math.min(1, n.alpha * 2.2) : n.alpha;
        // 全站只有黑白：被路由的節點靠「更亮 + 拖尾」區分，不靠色相
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(Math.round(n.x), Math.round(n.y), n.size, n.size);
        if (n.routing) {
          for (let t = 1; t <= 4; t++) {
            ctx.globalAlpha = n.alpha * (0.45 / t);
            ctx.fillRect(
              Math.round(n.x - n.vx * t * 3),
              Math.round(n.y - n.vy * t * 3),
              n.size,
              n.size,
            );
          }
        }
      }
      ctx.globalAlpha = 1;
    };

    const step = () => {
      for (const n of nodes) {
        if (n.routing) {
          n.x += n.vx;
          n.y += n.vy;
          if (n.y < -12 || n.x > canvas.width + 12) {
            Object.assign(n, seed(canvas.width, canvas.height), { y: canvas.height + 6 });
          }
        } else {
          n.y -= n.speed;
          if (n.y < -6) n.y = canvas.height + 6;
          if (Math.random() < 0.00035) {
            n.routing = true;
            n.vx = (1.1 + Math.random()) * dpr;
            n.vy = -(1.4 + Math.random() * 1.2) * dpr;
          }
        }
      }
      draw();
      raf = requestAnimationFrame(step);
    };

    let inView = true;
    const shouldRun = () => inView && !document.hidden && !reduced;
    const restart = () => {
      cancelAnimationFrame(raf);
      if (shouldRun()) raf = requestAnimationFrame(step);
    };

    resize();
    if (reduced) draw();
    else raf = requestAnimationFrame(step);

    const onVisibility = () => restart();
    const io = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? false;
      restart();
    });
    io.observe(canvas);
    const ro = new ResizeObserver(() => {
      resize();
      if (reduced) draw();
    });
    ro.observe(canvas);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reduced]);

  return <canvas ref={canvasRef} className={`field ${className}`} />;
}
