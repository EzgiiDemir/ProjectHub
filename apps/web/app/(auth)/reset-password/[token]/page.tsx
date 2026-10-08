'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Field } from '@/components/ui';

export default function ResetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== again) return setError('Şifreler eşleşmiyor');
    try {
      await api('/auth/password-reset/confirm', { method: 'POST', body: { token, password } });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <main className="auth">
      <form className="card" onSubmit={submit}>
        <h1 style={{ marginBottom: 14 }}>Yeni şifre belirleyin</h1>
        {done ? (
          <div className="okbox">
            Şifreniz güncellendi ve tüm oturumlarınız kapatıldı. <Link href="/login">Giriş yapın</Link>.
          </div>
        ) : (
          <>
            <Field id="pw" label="Yeni şifre" hint="En az 12 karakter, harf ve rakam içermeli">
              <input id="pw" className="in" type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field id="pw2" label="Yeni şifre (tekrar)">
              <input id="pw2" className="in" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
            </Field>
            {error && <div className="badbox" style={{ marginBottom: 12 }}>{error}</div>}
            <button className="btn pri" style={{ width: '100%', justifyContent: 'center', padding: 10 }}>
              Şifreyi kaydet
            </button>
          </>
        )}
      </form>
    </main>
  );
}
