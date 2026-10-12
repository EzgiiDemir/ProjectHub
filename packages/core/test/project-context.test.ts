import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiMemories, codeChunks, organizations, projects, type DatabaseHandle } from '@projecthub/database';
import { freshDatabase } from '../../../test/support/db.js';
import { buildProjectContext } from '../src/ai/index.js';

let h: DatabaseHandle;

beforeAll(async () => {
  h = await freshDatabase();
});

afterAll(async () => {
  await h?.close();
});

describe('persistent project context retrieval', () => {
  it('combines lexical code retrieval with verified memory and never crosses project boundaries', async () => {
    const org = (await h.db.insert(organizations).values({ name: 'O', slug: 'o' }).returning())[0]!;
    const [project, other] = await h.db.insert(projects).values([
      { organizationId: org.id, name: 'Ödeme', slug: 'odeme', technologies: ['TypeScript'] },
      { organizationId: org.id, name: 'Gizli', slug: 'gizli', technologies: ['Go'] },
    ]).returning();
    await h.db.insert(codeChunks).values({ projectId: project!.id, path: 'src/payment.ts', startLine: 10, endLine: 12, content: 'export function calculatePaymentTotal(items: Item[]) { return sum(items); }' });
    await h.db.insert(aiMemories).values([
      { organizationId: org.id, projectId: project!.id, category: 'decision', title: 'Ödeme yuvarlama kararı', content: 'Tutarlar ödeme sağlayıcısına gönderilmeden önce kuruş cinsine çevrilir.', verification: 'verified', sourceType: 'user', sourceLabel: 'ADR-12', createdByType: 'user' },
      { organizationId: org.id, projectId: other!.id, category: 'fact', title: 'Gizli ödeme anahtarı', content: 'Bu başka projeye ait bilgi yanıtta görünmemeli.', verification: 'verified', sourceType: 'user', createdByType: 'user' },
    ]);

    const context = await buildProjectContext(h.db, project!.id, 'ödeme payment tutarı nasıl hesaplanır');
    expect(context.text).toContain('Ödeme yuvarlama kararı');
    expect(context.text).toContain('src/payment.ts:10-12');
    expect(context.text).not.toContain('Gizli ödeme anahtarı');
    expect(context.citations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'memory', label: 'Hafıza: Ödeme yuvarlama kararı' }),
      expect.objectContaining({ type: 'file', ref: 'src/payment.ts', line: 10 }),
    ]));
  });

  it('uses local semantic vectors when words do not overlap and keeps unrelated chunks out', async () => {
    const org = (await h.db.insert(organizations).values({ name: 'Semantic', slug: 'semantic' }).returning())[0]!;
    const project = (await h.db.insert(projects).values({ organizationId: org.id, name: 'Oturum', slug: 'oturum', technologies: ['TypeScript'] }).returning())[0]!;
    await h.db.insert(codeChunks).values([
      {
        projectId: project.id,
        path: 'src/session.ts',
        startLine: 4,
        endLine: 8,
        content: 'export function rotateSessionCredential() { return issueReplacementCredential(); }',
        embedding: [1, 0, 0],
        embeddingModel: 'test-local-embedding',
      },
      {
        projectId: project.id,
        path: 'src/invoice.ts',
        startLine: 2,
        endLine: 4,
        content: 'export function calculateInvoiceSubtotal() { return 42; }',
        embedding: [0, 1, 0],
        embeddingModel: 'test-local-embedding',
      },
    ]);

    const context = await buildProjectContext(h.db, project.id, 'müşterinin kimlik doğrulamasını kesintisiz devam ettir', {
      embedding: { model: 'test-local-embedding', embed: async () => [[1, 0, 0]] },
    });

    expect(context.text).toContain('src/session.ts:4-8');
    expect(context.text).not.toContain('src/invoice.ts');
    expect(context.citations).toContainEqual(expect.objectContaining({ type: 'file', ref: 'src/session.ts', line: 4 }));
  });
});
