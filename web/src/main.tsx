import { StrictMode, createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import type { Me } from '../../shared/types';
import { api } from './lib/api';
import { Login } from './pages/Login';
import { Home } from './pages/Home';
import { Solo } from './pages/Solo';
import { PartyHost } from './pages/PartyHost';
import { Join } from './pages/Join';
import { Remote } from './pages/Remote';
import './styles.css';

const MeContext = createContext<{ me: Me; signOut: () => void } | null>(null);
export const useMe = () => useContext(MeContext)!;

/** Pages that need a Spotify sign-in. Phones joining a party never go through here. */
function Authed({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    // Any failure (401 or server down) shows the sign-in page, which explains what's missing.
    api.me().then(setMe).catch(() => setMe(null));
  }, []);
  if (me === undefined) {
    return (
      <div className="page center" style={{ paddingTop: '30vh' }}>
        <span className="spin" />
      </div>
    );
  }
  if (me === null) return <Login />;
  const signOut = () => api.logout().finally(() => (window.location.href = '/'));
  return <MeContext.Provider value={{ me, signOut }}>{children}</MeContext.Provider>;
}

/** Old /join/CODE links go to /play/CODE. */
function JoinRedirect() {
  const { code } = useParams();
  return <Navigate to={code ? `/play/${code}` : '/play'} replace />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/play/:code?" element={<Join />} />
        <Route path="/join/:code?" element={<JoinRedirect />} />
        <Route path="/solo" element={<Authed><Solo /></Authed>} />
        <Route path="/party" element={<Authed><PartyHost /></Authed>} />
        {/* The host remote talks only to /play/socket.io, so it needs no /api access (works behind an access proxy). */}
        <Route path="/play/host" element={<Remote />} />
        <Route path="/remote" element={<Navigate to="/play/host" replace />} />
        <Route path="*" element={<Authed><Home /></Authed>} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
