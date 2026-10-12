import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '../../..');
const fixture = path.join(root, 'test/fixtures/nova-shop');
const stamp = Date.now().toString(36);
const name = `E2E Mağaza ${stamp}`;
const slug = `e2e-magaza-${stamp}`;
const deployDir = process.env.E2E_DEPLOY_DIR ?? path.join(root, '.data/storage/deploy-local', `e2e-${stamp}`);

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#email', process.env.E2E_EMAIL ?? 'ezgidemir824@gmail.com');
  await page.fill('#password', process.env.E2E_PASSWORD ?? '');
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

/**
 * The product's main promise in one run: an existing project goes from a folder on disk to a customer
 * review and a deployment, through the same screens people use.
 */
test('import → build → preview → customer feedback → version → deploy', async ({ page, browser }) => {
  test.skip(!process.env.E2E_PASSWORD, 'Set E2E_EMAIL and E2E_PASSWORD for an organization admin');
  await login(page);

  // 1. Smart import of a folder (zipped in the browser) with detection.
  await page.goto('/projects/new');
  await page.setInputFiles('input[webkitdirectory]', fixture);
  await expect(page.getByText('dosya alındı')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Node.js uygulaması').first()).toBeVisible();
  await page.fill('#np-name', name);
  await expect(page.locator('#np-slug')).toHaveValue(slug);
  await page.getByRole('button', { name: 'İçe aktar' }).click();
  await page.waitForURL(`**/projects/${slug}`);
  await expect(page.getByText('Proje tanındı').first()).toBeVisible({ timeout: 60_000 });

  // Uploaded sources start untrusted: an authorized person reviews the fixture and allows build commands.
  await page.goto(`/projects/${slug}/settings`);
  await page.selectOption('#pg-trust', 'trusted');
  await page.getByRole('button', { name: 'Kaydet' }).first().click();
  await expect(page.getByText('Yalnızca kaynağını ve build betiklerini incelediğiniz')).toBeVisible();
  await page.waitForLoadState('networkidle');

  // 2. Build with a preview; the log streams live and every step passes.
  await page.goto(`/projects/${slug}/builds`);
  await page.getByRole('button', { name: 'Build başlat' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Başlat', exact: true }).click();
  await page.waitForURL(/\/builds\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: /Build #1/ }).getByText('Başarılı')).toBeVisible({ timeout: 4 * 60_000 });
  await expect(page.locator('pre.log')).toContainText('npm run build');

  // 3. The preview comes up.
  await page.goto(`/projects/${slug}/previews`);
  await expect(page.getByText('Hazır').first()).toBeVisible({ timeout: 90_000 });

  // 4. A customer link for the preview.
  await page.goto(`/projects/${slug}/reviews?new=1`);
  await page.getByRole('dialog').getByRole('button', { name: 'Linki oluştur' }).click();
  const linkText = await page.locator('.okbox code').first().textContent();
  const reviewUrl = linkText!.trim();
  expect(reviewUrl).toMatch(/\/r\/[A-Za-z0-9]{16,}$/);

  // 5. The customer (no account) pins feedback on the page.
  const customer = await (await browser.newContext({ locale: 'tr-TR', viewport: { width: 1440, height: 950 } })).newPage();
  await customer.goto(reviewUrl);
  await customer.fill('#g-fn', 'Deniz');
  await customer.fill('#g-ln', 'Kaya');
  await customer.selectOption('#g-dep', 'Pazarlama');
  await customer.getByRole('button', { name: 'İncelemeye başla' }).click();
  await expect(customer.frameLocator('iframe').getByText('Nova Market').first()).toBeVisible({ timeout: 60_000 });
  await customer.getByRole('button', { name: 'Geri bildirim bırak' }).click();
  const overlay = await customer.locator('.fb-overlay').boundingBox();
  await customer.mouse.click(overlay!.x + overlay!.width * 0.3, overlay!.y + overlay!.height * 0.3);
  await customer.fill('#pf-title', 'Başlık rengi kurumsal yeşil olsun');
  await customer.getByRole('button', { name: 'Gönder' }).click();
  await expect(customer.getByText('Başlık rengi kurumsal yeşil olsun')).toBeVisible();
  await customer.context().close();

  // 6. The team sees it with context.
  await page.goto(`/projects/${slug}/feedback`);
  await page.getByText('Başlık rengi kurumsal yeşil olsun').click();
  await expect(page.getByText('Deniz Kaya').first()).toBeVisible();
  await expect(page.getByText('Pazarlama').first()).toBeVisible();

  // 7. Release: version from the build, local deployment target, deploy to staging.
  await page.goto(`/projects/${slug}/versions?new=1`);
  await page.getByRole('dialog').getByRole('button', { name: 'Oluştur', exact: true }).click();
  await expect(page.getByText(/v1\.2\.\d/).first()).toBeVisible();
  await page.goto(`/projects/${slug}/environments`);
  const staging = page.locator('section.panel', { hasText: 'Staging' });
  await staging.getByTitle('Ortam ayarları').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sunucu klasörü' }).click();
  await page.fill('#tg-path', deployDir);
  await page.getByRole('dialog').getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(page.getByText('Yayın hedefi kaydedildi')).toBeVisible();
  await page.keyboard.press('Escape');
  await staging.getByRole('button', { name: 'Deploy' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deploy et' }).click();
  await page.waitForURL(/\/deployments\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading').getByText('Tamamlandı')).toBeVisible({ timeout: 2 * 60_000 });

  // 8. Archive (projects are never deleted).
  await page.goto(`/projects/${slug}/settings?tab=danger`);
  await page.getByRole('button', { name: 'Arşivle' }).click();
  await page.getByRole('dialog').locator('input').fill(slug);
  await page.getByRole('dialog').getByRole('button', { name: 'Arşivle' }).click();
  await expect(page.getByText('Bu proje arşivde.')).toBeVisible();
});
