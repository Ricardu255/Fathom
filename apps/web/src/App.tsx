import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { AppStatusBar } from "./components/AppStatusBar";
import { CommandPalette } from "./components/CommandPalette";
import { PaperFrame } from "./components/PaperFrame";
import { Sidebar } from "./components/Sidebar";
import { BoardPage } from "./features/board/BoardPage";
import { ChatPage } from "./features/chat/ChatPage";
import { HomePage } from "./features/chat/HomePage";
import { LiteraturePage } from "./features/literature/LiteraturePage";
import { MemoryPage } from "./features/memory/MemoryPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { TracePage } from "./features/trace/TracePage";
import { UsagePage } from "./features/usage/UsagePage";
import { WorkflowPage } from "./features/workflow/WorkflowPage";

export function App() {
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 路由变化时关闭移动端抽屉
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  return (
    <>
      <div className={`app-shell${navOpen ? " nav-open" : ""}`}>
        <Sidebar />
        {navOpen ? (
          <button
            aria-label="关闭导航"
            className="sidebar-scrim"
            onClick={() => setNavOpen(false)}
            type="button"
          />
        ) : null}
        <main className="main-area">
          <AppStatusBar onToggleNav={() => setNavOpen((open) => !open)} />
          <Routes>
            <Route element={<HomePage />} path="/" />
            <Route element={<ChatRoute />} path="/s/:sessionId" />
            <Route element={<TraceRoute />} path="/s/:sessionId/trace" />
            <Route element={<BoardPage />} path="/board" />
            <Route element={<UsagePage />} path="/usage" />
            <Route element={<LiteraturePage />} path="/literature" />
            <Route element={<MemoryPage />} path="/memory" />
            <Route element={<WorkflowPage />} path="/workflows" />
            <Route element={<SettingsPage />} path="/settings" />
            <Route element={<Navigate replace to="/" />} path="*" />
          </Routes>
        </main>
      </div>
      <CommandPalette />
      <PaperFrame />
    </>
  );
}

function ChatRoute() {
  const { sessionId } = useParams();
  if (sessionId === undefined) return <Navigate replace to="/" />;
  return <ChatPage key={sessionId} sessionId={sessionId} />;
}

function TraceRoute() {
  const { sessionId } = useParams();
  if (sessionId === undefined) return <Navigate replace to="/" />;
  return <TracePage key={sessionId} sessionId={sessionId} />;
}
