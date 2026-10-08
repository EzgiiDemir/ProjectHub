'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Field } from '@/components/ui';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login', { method: 'POST', body: { email, password } });
      qc.clear();
      const next = params.get('next');
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="row" style={{ marginBottom: 20 }}>
        <span className="brand-mark">PH</span>
        <b style={{ fontSize: 17 }}>Project Hub</b>
      </div>
      <h1 style={{ marginBottom: 6 }}>Giriş yapın</h1>
      <p className="sub" style={{ marginBottom: 18 }}>Şirket hesabınızla devam edin.</p>
      <Field id="email" label="E-posta">
        <input id="email" className="in" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      </Field>
      <Field id="password" label="Şifre">
        <input id="password" className="in" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {error && (
        <div className="badbox" role="alert" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}
      <button className="btn pri" style={{ width: '100%', justifyContent: 'center', padding: 10 }} disabled={busy}>
        {busy && <span className="spinner" />} Giriş yap
      </button>
      <p className="small muted" style={{ marginTop: 14, textAlign: 'center' }}>
        <Link href="/forgot-password">Şifremi unuttum</Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="auth">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
