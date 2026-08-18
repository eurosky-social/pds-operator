import { useEffect, useState } from "react";
import { api } from "./api.js";
import { Login } from "./Login.js";
import { StatusPanel } from "./StatusPanel.js";
import { AccountsPanel } from "./AccountsPanel.js";
import { PasskeysPanel } from "./PasskeysPanel.js";
import { AuditPanel } from "./AuditPanel.js";
import { RequestCrawl } from "./RequestCrawl.js";
import { SyncFooter } from "./SyncFooter.js";
import { InvitesPanel } from "./InvitesPanel.js";
import { StatsPanel } from "./StatsPanel.js";
import { OperatorsPanel } from "./OperatorsPanel.js";
import { Enroll } from "./Enroll.js";

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [appviewUrl, setAppviewUrl] = useState("https://bsky.app");
  const [pdsHostname, setPdsHostname] = useState("");
  const [passwordLogin, setPasswordLogin] = useState(true);
  const [pendingAdmins, setPendingAdmins] = useState(false);
  const [lastFullSync, setLastFullSync] = useState<string | null>(null);
  // object wrapper so clicking the same handle twice still retriggers the search
  const [accountSearch, setAccountSearch] = useState<{ q: string } | null>(null);
  const [enrollToken] = useState(
    () => new URLSearchParams(window.location.search).get("enroll"),
  );

  useEffect(() => {
    api
      .session()
      .then((s) => {
        setAuthed(s.authenticated);
        if (s.appviewUrl) setAppviewUrl(s.appviewUrl);
        if (s.pdsHostname) setPdsHostname(s.pdsHostname);
        setPasswordLogin(s.passwordLogin ?? true);
        setPendingAdmins(s.pendingAdmins ?? false);
      })
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    document.title = pdsHostname ? `${pdsHostname} — operator` : "PDS Operator";
  }, [pdsHostname]);

  if (authed === null) return null;
  if (!authed && enrollToken) {
    return (
      <Enroll token={enrollToken} pdsHostname={pdsHostname} onEnrolled={() => setAuthed(true)} />
    );
  }
  if (!authed) {
    return (
      <Login
        pdsHostname={pdsHostname}
        passwordLogin={passwordLogin}
        pendingAdmins={pendingAdmins}
        onLoggedIn={() => setAuthed(true)}
      />
    );
  }

  return (
    <div className="app">
      <header className="header">
        <h1>{pdsHostname || "pds"} / operator</h1>
        <div className="header-actions">
          <RequestCrawl className="nav-crawl" />
          <button
            onClick={() =>
              api.logout().then(() => setAuthed(false))
            }
          >
            sign out
          </button>
        </div>
      </header>
      <StatusPanel onLastSync={setLastFullSync} />
      <AccountsPanel appviewUrl={appviewUrl} searchFor={accountSearch} />
      <StatsPanel onSearchAccount={(handle) => setAccountSearch({ q: handle })} />
      <InvitesPanel />
      <OperatorsPanel />
      <PasskeysPanel />
      <AuditPanel />
      <SyncFooter lastFullSync={lastFullSync} />
    </div>
  );
}
