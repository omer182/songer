import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export function Login() {
  const [cfg, setCfg] = useState<{ spotifyConfigured: boolean; redirectUri: string } | null>(null);
  const error = new URLSearchParams(window.location.search).get('error');
  useEffect(() => {
    api.config().then(setCfg).catch(() => {});
  }, []);

  return (
    <div className="page">
      <div className="hero">
        <div className="bars" aria-hidden="true">
          {[14, 22, 36, 55, 78, 100].map((h, i) => (
            <span key={i} className={i < 3 ? 'on' : ''} style={{ height: `${h}%` }} />
          ))}
        </div>
        <h1 className="h1">
          song<span style={{ color: 'var(--pink)' }}>er</span>
        </h1>
        <p className="muted" style={{ margin: 0, maxWidth: 420 }}>
          Name the song from its first half-second. Your music comes from your Spotify: top tracks, liked songs, any band or playlist.
        </p>
        {error && <div className="err">{error}</div>}
        {window.location.pathname === '/remote' && (
          <div className="tip">
            Using your phone as the host remote? On the laptop, open <b>Party</b> and tap <b>📱 Host remote</b>, then scan that QR code with this phone.
          </div>
        )}
        {cfg && !cfg.spotifyConfigured ? (
          <div className="tip" style={{ textAlign: 'left' }}>
            <b style={{ color: 'var(--fg)' }}>Spotify isn't set up yet.</b> Create an app at developer.spotify.com/dashboard, add the redirect URI{' '}
            <code className="mono" style={{ color: 'var(--yellow)' }}>{cfg.redirectUri}</code>, then put the Client ID and Secret in <code className="mono">.env</code> and restart the server.
          </div>
        ) : (
          <a className="btn spotify lg" href="/api/auth/login">
            Sign in with Spotify
          </a>
        )}
        <p className="muted small" style={{ margin: 0 }}>
          Playing songs needs Spotify Premium and Chrome, Edge or Firefox on a computer. Party guests just scan a QR code.
        </p>
      </div>
    </div>
  );
}
