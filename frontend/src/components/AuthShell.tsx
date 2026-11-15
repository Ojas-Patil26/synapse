import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Brand } from "./Brand";
import { ThemeToggle } from "./ThemeToggle";

/** Page frame for the public, signed-out pages (confirm email, reset password, privacy). */
export function AuthShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="auth-page">
      <header className="topnav topnav-plain">
        <Brand to="/" />
        <div className="nav-right">
          <ThemeToggle />
          <Link className="btn btn-small btn-quiet" to="/login">
            Log in
          </Link>
        </div>
      </header>
      {wide ? <div className="legal">{children}</div> : children}
    </div>
  );
}
