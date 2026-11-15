// Fades and lifts its children in the first time they scroll into view.
// With prefers-reduced-motion the content is simply shown (the CSS removes the transition).
import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Stagger in milliseconds. */
  delay?: number;
  as?: ElementType;
  className?: string;
}

export function Reveal({ children, delay = 0, as: Tag = "div", className = "" }: Props) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add("js");
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -6% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag ref={ref} className={`reveal${shown ? " is-in" : ""} ${className}`.trim()} style={{ "--reveal-delay": `${delay}ms` } as CSSProperties}>
      {children}
    </Tag>
  );
}
