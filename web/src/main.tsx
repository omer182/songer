import { StrictMode, createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/join/:code?" element={<Join />} />
        <Route path="/solo" element={<Authed><Solo /></Authed>} />
        <Route path="/party" element={<Authed><PartyHost /></Authed>} />
        <Route path="/remote" element={<Authed><Remote /></Authed>} />
        <Route path="*" element={<Authed><Home /></Authed>} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
