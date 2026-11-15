import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { auth, type Session } from "../auth";

interface SessionCtx {
  session: Session | null;
  /** True until the stored session has been checked. */
  loading: boolean;
  signIn(email: string, password: string): Promise<void>;
  /** Resolves "confirm" when the new account must confirm its email with a code before it can sign in. */
  signUp(email: string, password: string): Promise<"signed-in" | "confirm">;
  signOut(): void;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    auth
      .getSession()
      .then((s) => live && setSession(s))
      .catch(() => live && setSession(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => setSession(await auth.signIn(email, password)), []);
  const signUp = useCallback(async (email: string, password: string): Promise<"signed-in" | "confirm"> => {
    const result = await auth.signUp(email, password);
    if (result === "confirm") return "confirm";
    setSession(result);
    return "signed-in";
  }, []);
  const signOut = useCallback(() => {
    auth.signOut();
    setSession(null);
  }, []);

  const value = useMemo(() => ({ session, loading, signIn, signUp, signOut }), [session, loading, signIn, signUp, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}
