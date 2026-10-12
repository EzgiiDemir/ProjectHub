'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { ALL_PERMISSIONS, ORG_ONLY_PERMISSIONS, PERMISSIONS, type Permission } from '@projecthub/contracts';
import { api, errorMessage } from '@/lib/api';
import type { Role } from '@/lib/types';
import { Async, ConfirmDialog, Drawer, Field, PageHeader, Panel } from '@/components/ui';
import { useToast } from '@/components/toast';

const GROUPS = [...new Set(ALL_PERMISSIONS.map((p) => PERMISSIONS[p].group))];

/** Role-based access (spec §119–121): a matrix of what each role can do; system roles are fixed, custom roles editable. */
export default function RolesPage() {
  const q = useQuery({ queryKey: ['roles'], queryFn: () => api<Role[]>('/admin/roles') });
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  return (
    <div className="page">
      <PageHeader
        title="Roller ve yetkiler"
        sub="Sistem rolleri değiştirilemez; ihtiyaca göre özel rol oluşturun. Proje üyeliğinde verilen rol, kullanıcının o projedeki yetkilerini belirler."
        actions={
          <button className="btn pri" onClick={() => setEditing('new')}>
            <Plus /> Özel rol
          </button>
        }
      />
      <Async q={q} rows={8}>
        {(roles) => (
          <Panel flush>
            <div className="tbl">
              <table>
                <thead>
                  <tr>
                    <th style={{ minWidth: 260 }}>Yetki</th>
                    {roles.map((r) => (
                      <th key={r.id} style={{ textAlign: 'center', whiteSpace: 'normal', minWidth: 90 }}>
                        <button className="btn sm ghost" style={{ fontWeight: 600 }} onClick={() => setEditing(r)} title={r.description}>
                          {r.name}
                        </button>
                        <div className="small muted" style={{ fontWeight: 400 }}>
                          {r.memberCount} kişi{r.isSystem ? ' · sistem' : ''}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {GROUPS.map((g) => (
                    <GroupRows key={g} group={g} roles={roles} />
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
      </Async>
      {editing && <RoleDrawer role={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function GroupRows({ group, roles }: { group: string; roles: Role[] }) {
  const perms = ALL_PERMISSIONS.filter((p) => PERMISSIONS[p].group === group);
  return (
    <>
      <tr>
        <td colSpan={roles.length + 1} className="small" style={{ background: 'var(--sunk2)', fontWeight: 600 }}>
          {group}
        </td>
      </tr>
      {perms.map((p) => (
        <tr key={p}>
          <td>
            {PERMISSIONS[p].label}
            <div className="mono small muted">{p}</div>
          </td>
          {roles.map((r) => (
            <td key={r.id} style={{ textAlign: 'center', color: r.permissions.includes(p) ? 'var(--ok)' : 'var(--faint)' }}>
              {r.permissions.includes(p) ? '✓' : '·'}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function RoleDrawer({ role, onClose }: { role: Role | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [perms, setPerms] = useState<Permission[]>(role?.permissions ?? ['project.read', 'repository.read']);
  const [deleting, setDeleting] = useState(false);
  const readOnly = !!role?.isSystem;
  const done = (msg: string) => {
    toast(msg);
    void qc.invalidateQueries({ queryKey: ['roles'] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () => api(role ? `/admin/roles/${role.id}` : '/admin/roles', { method: role ? 'PUT' : 'POST', body: { name, description, permissions: perms } }),
    onSuccess: () => done('Rol kaydedildi'),
  });
  const del = useMutation({ mutationFn: () => api(`/admin/roles/${role!.id}`, { method: 'DELETE' }), onSuccess: () => done('Rol silindi'), onError: (e) => toast(errorMessage(e), 'bad') });
  return (
    <Drawer
      title={role ? role.name : 'Özel rol'}
      onClose={onClose}
      wide
      footer={
        !readOnly && (
          <>
            {role && (
              <button className="btn danger" onClick={() => setDeleting(true)} style={{ marginRight: 'auto' }}>
                Sil
              </button>
            )}
            <button className="btn" onClick={onClose}>
              Vazgeç
            </button>
            <button className="btn pri" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
              Kaydet
            </button>
          </>
        )
      }
    >
      {readOnly && <div className="warnbox small" style={{ marginBottom: 12 }}>Sistem rolü; değiştirilemez. Farklı bir yetki seti için özel rol oluşturun.</div>}
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="grid g2">
          <Field label="Ad" id="rl-name">
            <input id="rl-name" className="in" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </Field>
          <Field label="Açıklama" id="rl-desc">
            <input id="rl-desc" className="in" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </Field>
        </div>
        <div className="grid g2">
          {GROUPS.map((g) => (
            <div key={g}>
              <div className="small" style={{ fontWeight: 600, margin: '8px 0 2px' }}>
                {g}
              </div>
              {ALL_PERMISSIONS.filter((p) => PERMISSIONS[p].group === g).map((p) => (
                <label key={p} className="check" style={{ alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={perms.includes(p)} onChange={(e) => setPerms((x) => (e.target.checked ? [...x, p] : x.filter((y) => y !== p)))} />
                  <span>
                    {PERMISSIONS[p].label}
                    {ORG_ONLY_PERMISSIONS.includes(p) && <span className="small muted"> · yalnızca organizasyon rolünde</span>}
                  </span>
                </label>
              ))}
            </div>
          ))}
        </div>
      </fieldset>
      {save.error && <div className="badbox" style={{ marginTop: 10 }}>{errorMessage(save.error)}</div>}
      {deleting && role && (
        <ConfirmDialog
          title="Rolü sil"
          message={role.memberCount ? `Bu rol ${role.memberCount} kişiye atanmış; silinemez. Önce kullanıcıların rolünü değiştirin.` : 'Rol silinir.'}
          actionLabel="Sil"
          busy={del.isPending}
          onConfirm={() => del.mutate()}
          onClose={() => setDeleting(false)}
        />
      )}
    </Drawer>
  );
}
