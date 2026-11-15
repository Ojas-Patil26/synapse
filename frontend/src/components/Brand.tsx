import { Link } from "react-router-dom";

export function Brand({ to }: { to: string }) {
  return (
    <Link to={to} className="brand" aria-label="Synapse">
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M9 21.5 16 9.5l8 12.5" fill="none" className="brand-line" strokeWidth="1.8" />
        <circle cx="16" cy="9.5" r="4.4" className="brand-a" />
        <circle cx="16" cy="9.5" r="6.9" fill="none" className="brand-ring" strokeWidth="1.6" />
        <circle cx="9" cy="22" r="3.7" className="brand-b" />
        <circle cx="24" cy="22" r="3.7" className="brand-c" />
      </svg>
      <span>Synapse</span>
    </Link>
  );
}
