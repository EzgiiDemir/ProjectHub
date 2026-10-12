'use client';

import { useId, useState } from 'react';

const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 200 * 1024;

/** Logo picker for customer portal branding: PNG/JPEG/WebP up to 200 KB, kept as a data URL. */
export function LogoInput({ label, value, disabled, onChange }: { label: string; value: string | null; disabled?: boolean; onChange: (v: string | null) => void }) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const pick = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!TYPES.includes(file.type)) return setError('PNG, JPEG veya WebP seçin');
    if (file.size > MAX_BYTES) return setError('Logo en fazla 200 KB olabilir');
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result));
    reader.onerror = () => setError('Dosya okunamadı');
    reader.readAsDataURL(file);
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <div style={{ width: 120, height: 48, border: '1px dashed var(--line)', borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--sunk2)', overflow: 'hidden' }}>
          {value ? <img src={value} alt={label} style={{ maxWidth: 112, maxHeight: 40, objectFit: 'contain' }} /> : <span className="small muted">Yok</span>}
        </div>
        <input id={id} type="file" accept={TYPES.join(',')} disabled={disabled} onChange={(e) => pick(e.target.files?.[0])} style={{ maxWidth: 220 }} />
        {value && !disabled && (
          <button type="button" className="btn sm" onClick={() => onChange(null)}>
            Kaldır
          </button>
        )}
      </div>
      {error && <div className="small" style={{ color: 'var(--bad)', marginTop: 4 }}>{error}</div>}
    </div>
  );
}
