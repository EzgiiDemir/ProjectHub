import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, client as makeClient, startHarness, waitFor, type Harness } from './harness.js';

let h: Harness;
const admin = makeClient(() => h.base);
const dev = makeClient(() => h.base);
const outsider = makeClient(() => h.base);
const slug = 'takim-projesi';
let projectId = '';
let devId = '';
let outsiderId = '';

async function invite(c: ReturnType<typeof makeClient>, email: string, roleKey: string, member: boolean) {
  const roles = (await admin.get('/admin/roles')).data as { id: string; key: string }[];
  const inv = await admin.post('/admin/users', { email, displayName: email.split('@')[0], roleIds: [roles.find((r) => r.key === roleKey)!.id] });
  await c.post('/auth/invitations/accept', { token: new URL((inv.data as { invitationUrl: string }).invitationUrl).pathname.split('/').pop()!, password: 'Takim-Parola-2026' });
  const id = ((await c.get('/auth/me')).data as { user: { id: string } }).user.id;
  if (member) await admin.post(`/projects/${slug}/members`, { userId: id, roleId: null });
  return id;
}
const titles = async (c: ReturnType<typeof makeClient>) => ((await c.get('/notifications')).data as { items?: { title: string }[] } | { title: string }[]) as never as { title: string }[] | { items: { title: string }[] };
const notificationTitles = async (c: ReturnType<typeof makeClient>) => {
  const d = await titles(c);
  return (Array.isArray(d) ? d : d.items).map((n) => n.title);
};

beforeAll(async () => {
  h = await startHarness({ worker: true });
  await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
  projectId = ((await admin.post('/projects', { name: 'Takım Projesi', slug, source: { type: 'empty', template: 'static' } })).data as { id: string }).id;
  await waitFor(async () => ((await admin.get(`/projects/${slug}`)).data as { repository: { status: string } | null }).repository?.status === 'ready');
  devId = await invite(dev, 'gelistirici@example.com', 'developer', true);
  outsiderId = await invite(outsider, 'disarida@example.com', 'developer', false);
}, 180_000);

afterAll(async () => {
  await h?.close();
});

type Board = { tasks: { id: string; key: string; status: string; assignee: { id: string } | null; dueDate: string | null; labels: string[]; overdue: boolean; comments: number }[] };

describe('team work', () => {
  let taskId = '';
  let key = '';

  it('creates and assigns tasks only to people who can see the project', async () => {
    expect((await admin.post(`/projects/${slug}/tasks`, { title: 'Giriş ekranı', assigneeId: outsiderId })).status).toBe(400);
    const r = await admin.post(`/projects/${slug}/tasks`, { title: 'Giriş ekranı', description: 'E-posta ile giriş', priority: 'high', assigneeId: devId, dueDate: '2020-01-01', labels: ['frontend'] });
    expect(r.status).toBe(201);
    taskId = (r.data as { id: string }).id;
    key = (r.data as { key: string }).key;
    const board = (await dev.get('/team/board?mine=1')).data as Board;
    expect(board.tasks).toEqual([expect.objectContaining({ id: taskId, status: 'todo', dueDate: '2020-01-01', labels: ['frontend'], overdue: true })]);
    // The assignee is told (task.assigned).
    await waitFor(async () => (await notificationTitles(dev)).some((t) => t.includes(`${key} size atandı`)), 20_000);
  });

  it('moves through todo → doing → review → done with a history, comments and linked commits', async () => {
    for (const status of ['in_progress', 'in_review', 'done']) expect((await dev.raw('PATCH', `/tasks/${taskId}`, { status })).status).toBe(200);
    expect((await dev.post(`/tasks/${taskId}/comments`, { body: 'Tasarım onaylandı, birleştiriyorum.' })).status).toBe(201);
    const main = ((await admin.get(`/projects/${slug}/repo/branches`)).data as { branches: { name: string; sha: string }[] }).branches.find((b) => b.name === 'main')!.sha;
    await admin.post(`/projects/${slug}/repo/commits`, { branch: 'main', baseCommit: main, message: `${key}: giriş formu eklendi`, changes: [{ action: 'upsert', path: 'giris.html', content: '<form></form>' }] });

    const t = (await admin.get(`/tasks/${taskId}`)).data as { events: { kind: string; from: string | null; to: string | null; actor: string }[]; comments: { body: string; author: { id: string } }[]; commits: { subject: string; source: string }[] };
    expect(t.events.map((e) => `${e.kind}:${e.to ?? ''}`)).toEqual(['created:todo', 'assigned:gelistirici', 'status:in_progress', 'status:in_review', 'status:done', 'comment:']);
    expect(t.comments).toEqual([expect.objectContaining({ body: 'Tasarım onaylandı, birleştiriyorum.', author: expect.objectContaining({ id: devId }) })]);
    expect(t.commits).toEqual([expect.objectContaining({ subject: `${key}: giriş formu eklendi`, source: 'mention' })]);
    // The creator (admin) is told about the comment.
    await waitFor(async () => (await notificationTitles(admin)).some((x) => x.includes(`${key} yorumlandı`)), 20_000);
    expect((await outsider.get(`/tasks/${taskId}`)).status).toBe(404);
  });

  it('shows workload per person, project assignments and the activity stream', async () => {
    const m = (await admin.get('/team/members')).data as { people: { id: string; projects: { slug: string }[]; open: Record<string, number> }[] };
    expect(m.people.find((p) => p.id === devId)!.projects.map((p) => p.slug)).toEqual([slug]);
    expect(m.people.find((p) => p.id === outsiderId)!.projects).toEqual([]);
    const a = (await admin.get(`/team/activity?projectId=${projectId}`)).data as { items: { kind: string; title: string }[] };
    expect(a.items.some((i) => i.kind === 'commit')).toBe(true);
    expect(a.items.some((i) => i.title === `${key} yorumlandı`)).toBe(true);
  });

  it('runs a project discussion with replies, @mentions and pinning', async () => {
    const root = await admin.post(`/projects/${slug}/discussion`, { body: 'Sürüm 1.0 için son kontroller', mentions: [devId, outsiderId] });
    expect(root.status).toBe(201);
    const rootId = (root.data as { id: string }).id;
    const reply = await dev.post(`/projects/${slug}/discussion`, { body: 'Testler tamam', parentId: rootId });
    expect((await dev.post(`/projects/${slug}/discussion`, { body: 'iç içe', parentId: (reply.data as { id: string }).id })).status).toBe(400);
    expect((await dev.post(`/discussion/${rootId}/pin`)).status).toBe(403);
    expect((await admin.post(`/discussion/${rootId}/pin`)).status).toBe(201);
    const d = (await dev.get(`/projects/${slug}/discussion`)).data as { threads: { body: string; pinned: boolean; mentions: { id: string }[]; replies: { body: string }[] }[] };
    // Only people who can see the project are mentioned (and notified).
    expect(d.threads[0]).toMatchObject({ body: 'Sürüm 1.0 için son kontroller', pinned: true, replies: [expect.objectContaining({ body: 'Testler tamam' })] });
    expect(d.threads[0]!.mentions.map((x) => x.id)).toEqual([devId]);
    await waitFor(async () => (await notificationTitles(dev)).some((t) => t.includes('tartışmasında sizden bahsedildi')), 20_000);
    expect((await outsider.get(`/projects/${slug}/discussion`)).status).toBe(404);
  });
});
