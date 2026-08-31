import { useEffect, useState } from "react";

const SHOW_AFTER_PX = 320;
type ScrollWindow = typeof window & {
  scrollY: number;
  scrollTo(options: { top: number; behavior: "auto" | "smooth" }): void;
};

/** Global document navigation for long Calendar, Analytics and Box pages. */
export default function ScrollToTop() {
  const viewport = window as ScrollWindow;
  const [visible, setVisible] = useState(() => viewport.scrollY > SHOW_AFTER_PX);

  useEffect(() => {
    let frame = 0;
    const sync = () => {
      frame = 0;
      const next = viewport.scrollY > SHOW_AFTER_PX;
      setVisible((current) => (current === next ? current : next));
    };
    const onScroll = () => {
      if (frame === 0) frame = viewport.requestAnimationFrame(sync);
    };

    sync();
    viewport.addEventListener("scroll", onScroll);
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      if (frame !== 0) viewport.cancelAnimationFrame(frame);
    };
  }, [viewport]);

  if (!visible) return null;

  const scrollToTop = () => {
    const reduceMotion = viewport.matchMedia("(prefers-reduced-motion: reduce)").matches;
    viewport.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  };

  return (
    <button
      type="button"
      className="btn scroll-top"
      onClick={scrollToTop}
      aria-label="Scroll to top"
      title="Scroll to top"
    >
      <span aria-hidden="true">↑</span>
      <span>Up</span>
    </button>
  );
}
