import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { Brand } from "../components/Brand";
import { ThemeToggle } from "../components/ThemeToggle";
import { ForgettingCurve } from "../components/landing/ForgettingCurve";
import { HeroGraph } from "../components/landing/HeroGraph";
import { Reveal } from "../components/landing/Reveal";
import { SlideShiftField } from "../components/landing/SlideShiftField";
import { TwoAxes } from "../components/landing/TwoAxes";

const HEADLINE = "Know what you’ll forget before you forget it";

const STEPS: { title: string; body: string }[] = [
  {
    title: "Notes become a map",
    body: "Upload up to five files per course (PDF, PNG, JPG, TXT, or MD, including photographed handwriting). Synapse extracts the concepts into a hub-and-spoke map, and links ideas that appear across courses.",
  },
  {
    title: "Each concept has a forgetting curve",
    body: "Retention decays as R = e^(-t/S), with S fitted to your own review history. Node colour shows what is about to fade, not only what is already old, so you review the right concept before it drops.",
  },
  {
    title: "Quizzes measure understanding separately",
    body: "Colour is memory. The outline is confidence from short quizzes. A concept can be fresh but not understood, or understood but fading; the map shows both, so you know whether to re-read or just review.",
  },
];

export function Landing() {
  const [scrolled, setScrolled] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef<HTMLElement>(null);

  // Nav gets its backdrop once the top sentinel leaves the viewport (no scroll listener).
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setScrolled(!e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="landing">
      <div className="lp-atmosphere" aria-hidden="true">
        <div className="lp-atmosphere-wash" />
        <SlideShiftField flareRef={closingRef} />
        <div className="lp-atmosphere-scrim" />
      </div>
      <div ref={sentinelRef} className="lp-sentinel" aria-hidden="true" />
      <header className={`lp-nav${scrolled ? " is-scrolled" : ""}`}>
        <div className="lp-nav-in">
          <Brand to="/" />
          <div className="nav-right">
            <ThemeToggle />
            <Link className="btn btn-small btn-quiet" to="/login">
              Log in
            </Link>
            <Link className="btn btn-small btn-primary" to="/signup">
              Sign up
            </Link>
          </div>
        </div>
      </header>

      <section className="lp-section lp-hero">
        <div className="lp-copy">
          <h1 className="lp-h1" aria-label={HEADLINE}>
            {HEADLINE.split(" ").map((word, i) => (
              <span key={i} aria-hidden="true">
                <span className="lp-w" style={{ "--i": i } as CSSProperties}>
                  {word}
                </span>{" "}
              </span>
            ))}
          </h1>
          <p className="subhead lp-enter" style={{ "--d": "620ms" } as CSSProperties}>
            Notes become a map coloured by retention, outlined by quiz confidence.
          </p>
          <div className="hero-cta lp-enter" style={{ "--d": "740ms" } as CSSProperties}>
            <Link className="btn btn-primary btn-large" to="/signup">
              Sign up
            </Link>
            <Link className="btn btn-large" to="/login">
              Log in
            </Link>
          </div>
        </div>
        <div className="lp-hero-art lp-enter lp-enter-art" style={{ "--d": "420ms" } as CSSProperties}>
          <HeroGraph />
        </div>
      </section>

      <section className="lp-section lp-how" aria-labelledby="lp-how-title">
        <div className="lp-how-head">
          <Reveal>
            <h2 id="lp-how-title">From notes to the next review</h2>
          </Reveal>
        </div>
        <ol className="lp-steps">
          {STEPS.map((s, i) => (
            <Reveal key={s.title} as="li" className="lp-step" delay={i * 90}>
              <span className="lp-step-n" aria-hidden="true">
                {i + 1}
              </span>
              <div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            </Reveal>
          ))}
        </ol>
      </section>

      <section className="lp-section lp-demo" aria-labelledby="lp-curve-title">
        <Reveal className="lp-demo-head">
          <h2 id="lp-curve-title">Watch a memory fade</h2>
          <p>
            Drag the day, or press play. Review when retention nears the line and the next fade slows: the same schedule Synapse builds for every concept you upload.
          </p>
        </Reveal>
        <Reveal delay={80}>
          <ForgettingCurve />
        </Reveal>
      </section>

      <section className="lp-section lp-demo" aria-labelledby="lp-axes-title">
        <Reveal className="lp-demo-head">
          <h2 id="lp-axes-title">Two signals, one node</h2>
          <p>Colour shows how well you still remember a concept. The ring shows how well you understood it. Move both and see what they mean together.</p>
        </Reveal>
        <Reveal delay={80}>
          <TwoAxes />
        </Reveal>
      </section>

      <section ref={closingRef} className="lp-section lp-closing">
        <Reveal>
          <p className="closing">
            Stop rereading everything. <span>Review what’s about to fade.</span>
          </p>
          <div className="hero-cta lp-closing-cta">
            <Link className="btn btn-primary btn-large" to="/signup">
              Sign up
            </Link>
            <Link className="btn btn-large" to="/login">
              Log in
            </Link>
          </div>
        </Reveal>
      </section>

      <footer className="lp-section lp-footer">
        <span>Synapse</span>
        <nav aria-label="Footer">
          <Link to="/privacy">Privacy</Link>
          <Link to="/login">Log in</Link>
        </nav>
      </footer>
    </div>
  );
}
