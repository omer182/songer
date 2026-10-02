import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { LibraryStatus } from '../../../shared/types';
import { api } from '../lib/api';
import { isPhone } from '../lib/hooks';
import { Logo } from '../components/bits';
import { useMe } from '../main';

export function TopBar() {
  const { me, signOut } = useMe();
  return (
    <div className="topbar">
      <Logo />
      <div className="row">
        <span className="pill">
          {me.image ? <img src={me.image} alt="" /> : <span className="ava" />}
          {me.name}
        </span>
        <button className="btn ghost sm" onClick={signOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}

export function Home() {
  const [st, setSt] = useState<LibraryStatus | null>(null);

  useEffect(() => {
    let timer = 0;
    const load = () =>
      api
        .status()
        .then((s) => {
          setSt(s);
          if (s.status === 'syncing') timer = window.setTimeout(load, 2000);
        })
        .catch(() => {});
    load();
    return () => clearTimeout(timer);
  }, []);

  const resync = () => api.sync().then((s) => {
    setSt(s);
    const poll = () => api.status().then((x) => { setSt(x); if (x.status === 'syncing') setTimeout(poll, 2000); });
    setTimeout(poll, 1500);
  });

  return (
    <div className="page">
      <TopBar />
      <div className="stack" style={{ gap: 22, maxWidth: 900, margin: '0 auto' }}>
        <div className="stack tight">
          <h1 className="h1">What are we playing?</h1>
          {st && (
            <div className="statline">
              {st.status === 'syncing' ? (
                <span className="row"><span className="spin" /> Reading your Spotify library…</span>
              ) : (
                <>
                  <span><b>{st.counts.liked.toLocaleString()}</b> liked</span>
                  <span><b>{st.counts.playlists}</b> playlists</span>
                  <span><b>{st.counts.artists}</b> artists</span>
                  <span><b>{st.counts.indexed.toLocaleString()}</b> songs indexed for guessing</span>
                  <button className="back small" style={{ textDecoration: 'underline' }} onClick={resync}>Refresh</button>
                </>
              )}
            </div>
          )}
          {st?.status === 'error' && <div className="err">Library sync failed: {st.error}</div>}
        </div>

        {isPhone() && (
          <div className="tip">
            Spotify's web player doesn't run in phone browsers, so songs won't play here. Open Songer on a computer; phones join party games as buzzers.
          </div>
        )}

        <div className="modes">
          <Link to="/solo" className="mode">
            <span className="tag">Solo</span>
            <h2 className="h2">Quiz me</h2>
            <p className="muted" style={{ margin: 0 }}>
              Pick your top tracks, liked songs, a band or a playlist. Half a second of each song, six tries, and every miss plays a little more.
            </p>
          </Link>
          <Link to="/party" className="mode">
            <span className="tag">Party · teams</span>
            <h2 className="h2">Family night</h2>
            <p className="muted" style={{ margin: 0 }}>
              This laptop on the TV plays the music. Everyone scans a QR code, picks a team, and their phone becomes a buzzer. You judge the answers.
            </p>
          </Link>
        </div>
      </div>
    </div>
  );
}
