import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Account } from "./pages/Account";
import { AppIndex, AppShell } from "./pages/AppShell";
import { AuthPage } from "./pages/AuthPage";
import { ForgotPage } from "./pages/ForgotPage";
import { Guide } from "./pages/Guide";
import { GuideEntryPage } from "./pages/GuideEntry";
import { Home } from "./pages/Home";
import { Landing } from "./pages/Landing";
import { PrivacyPage } from "./pages/PrivacyPage";
import { Upload } from "./pages/Upload";
import { VerifyPage } from "./pages/VerifyPage";

export function App() {
  const location = useLocation();
  // Group /app/* under one key so AppShell stays mounted while top-level routes transition smoothly.
  const routeKey = location.pathname.startsWith("/app") ? "/app" : location.pathname;

  return (
    <div key={routeKey} className="page-transition">
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/signup" element={<AuthPage mode="signup" />} />
        <Route path="/verify" element={<VerifyPage />} />
        <Route path="/forgot" element={<ForgotPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/app" element={<AppShell />}>
          <Route index element={<AppIndex />} />
          <Route path="upload" element={<Upload />} />
          <Route path="home" element={<Home />} />
          <Route path="guide" element={<Guide />} />
          <Route path="guide/:conceptId" element={<GuideEntryPage />} />
          <Route path="account" element={<Account />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
