'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ErrorState, Field, Loading } from '@/components/ui';

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const invite = useQuery({ queryKey: ['invite', token], queryFn: () => api<{ email: string; displayName: string; organizationName: string }>(`/auth/invitations/${token}`), retry: false });
  const [name, setName] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== again) return setError('Şifreler eşleşmiyor');
    setBusy(true);
    setError(null);
    try {
      await api('/auth/invitations/accept', { method: 'POST', body: { token, password, displayName: name ?? invite.data?.displayName } });
      router.replace('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form className="card" onSubmit={submit}>
        <h1 style={{ marginBottom: 6 }}>Hesabınızı etkinleştirin</h1>
        {invite.isLoading && <Loading />}
        {invite.error && <ErrorState error={invite.error} />}
        {invite.data && (
          <>
            <p className="sub" style={{ marginBottom: 18 }}>
              <b>{invite.data.organizationName}</b> sizi Project Hub&apos;a davet etti ({invite.data.email}).
            </p>
            <Field id="name" label="Ad soyad">
              <input id="name" className="in" required value={name ?? invite.data.displayName} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field id="pw" label="Şifre" hint="En az 12 karakter, harf ve rakam içermeli">
              <input id="pw" className="in" type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field id="pw2" label="Şifre (tekrar)">
              <input id="pw2" className="in" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
            </Field>
            {error && <div className="badbox" style={{ marginBottom: 12 }}>{error}</div>}
            <button className="btn pri" style={{ width: '100%', justifyContent: 'center', padding: 10 }} disabled={busy}>
              {busy && <span className="spinner" />} Hesabı etkinleştir
            </button>
          </>
        )}
      </form>
    </main>
  );
}
