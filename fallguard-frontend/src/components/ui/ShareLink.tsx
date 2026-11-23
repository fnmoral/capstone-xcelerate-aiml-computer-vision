import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import './share-link.css';

/**
 * A link to hand to someone: the address, Copy, and a QR code to scan with a phone camera
 * (Download saves the QR as a PNG for slides or printouts).
 */
export function ShareLink({ url, label, fileName = 'fallguard-link' }: { url: string; label: string; fileName?: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    // Medium error correction and a white quiet zone: scans well from a projector or a phone screen.
    QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 512, color: { dark: '#16191d', light: '#ffffff' } })
      .then((d) => alive && setQr(d))
      .catch(() => alive && setQr(null));
    return () => { alive = false; };
  }, [url]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="share-link">
      {qr && (
        <figure className="share-link__qr">
          <img src={qr} alt={`QR code for ${label}`} width={168} height={168} />
          <figcaption>Scan with a phone camera</figcaption>
        </figure>
      )}
      <div className="share-link__body">
        <input readOnly value={url} className="share-link__url" onFocus={(e) => e.target.select()} aria-label={label} />
        <div className="row">
          <button type="button" className="btn btn--sm" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</button>
          {qr && <a className="btn btn--sm" href={qr} download={`${fileName}-qr.png`}>Download QR</a>}
        </div>
      </div>
    </div>
  );
}
