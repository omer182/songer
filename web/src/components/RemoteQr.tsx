import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** Pops up a one-time QR that signs your phone in as the host remote. */
export function RemoteQrButton({ className = 'btn ghost sm' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQr(null);
    setError(null);
    fetch('/api/pair', { method: 'POST', credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not make a link. Sign in again.'))))
      .then((d: { url: string }) => QRCode.toDataURL(d.url, { margin: 1, width: 400, color: { dark: '#14112b', light: '#ffffff' } }))
      .then(setQr)
      .catch((e: Error) => setError(e.message));
  }, [open]);

  return (
    <>
      <button className={className} onClick={() => setOpen(true)}>📱 Host remote</button>
      {open && (
        <div className="modal" role="dialog" aria-label="Host remote" onClick={() => setOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2 className="h2">Your phone as host remote</h2>
            <p className="muted small" style={{ margin: 0 }}>
              Scan with <b>your</b> phone (same Wi-Fi). It signs the phone in as you and shows each answer privately, with the judge buttons.
              The code works once and expires in 5 minutes.
            </p>
            <div className="qr" style={{ width: 240, margin: '0 auto' }}>{qr && <img src={qr} alt="QR code for the host remote" />}</div>
            {error && <div className="err">{error}</div>}
            <button className="btn" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </>
  );
}
