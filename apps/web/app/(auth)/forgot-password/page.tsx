'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Field } from '@/components/ui';

export default function ForgotPasswordPage() {
  const config = useQuery({ queryKey: ['authConfig'], queryFn: () => api<{ smtpEnabled: boolean }>('/auth/config') });
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/auth/password-reset/request', { method: 'POST', body: { email } });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <main className="auth">
      <form className="card" onSubmit={submit}>
        <h1 style={{ marginBottom: 6 }}>Şifre sıfırlama</h1>
        {config.data && !config.data.smtpEnabled ? (
          <div className="warnbox" style={{ margin: '14px 0' }}>
            Bu kurulumda e-posta gönderimi yapılandırılmamış. Şifre sıfırlama bağlantısı için sistem yöneticinize başvurun; yönetici Kullanıcılar
            sayfasından tek kullanımlık bir bağlantı oluşturabilir.
          </div>
        ) : sent ? (
          <div className="okbox" style={{ margin: '14px 0' }}>
            Bu e-posta ile kayıtlı aktif bir hesap varsa sıfırlama bağlantısı gönderildi. Bağlantı 2 saat geçerlidir.
          </div>
        ) : (
          <>
            <p className="sub" style={{ marginBottom: 18 }}>Hesabınızın e-posta adresini girin.</p>
            <Field id="email" label="E-posta">
              <input id="email" className="in" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </Field>
            {error && <div className="badbox" style={{ marginBottom: 12 }}>{error}</div>}
            <button className="btn pri" style={{ width: '100%', justifyContent: 'center', padding: 10 }}>
              Bağlantı gönder
            </button>
          </>
        )}
        <p className="small" style={{ marginTop: 14, textAlign: 'center' }}>
          <Link href="/login">Girişe dön</Link>
        </p>
      </form>
    </main>
  );
}
