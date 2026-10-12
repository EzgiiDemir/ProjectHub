import { describe, expect, it } from 'vitest';
import { scan } from '../src/index.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Registry fake: answers like registry.npmjs.org, pypi.org and repo.packagist.org; records every URL asked for. */
function fakeRegistries() {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (url === 'http://npm/react/latest') return json({ version: '19.2.0' });
    if (url === 'http://npm/@types%2fnode/latest') return json({ version: '24.1.0' });
    if (url === 'http://npm/left-pad/latest') return json({}, 404);
    if (url === 'http://pypi/pypi/django/json') return json({ info: { version: '5.2.1' } });
    if (url === 'http://packagist/p2/laravel/framework.json') return json({ packages: { 'laravel/framework': [{ version: 'v12.1.0' }, { version: 'v13.0.0-RC1' }, { version: 'v11.9.0' }] } });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { asked, fetchImpl };
}

describe('dependency center: inventory and latest versions', () => {
  it('classifies updates', () => {
    expect(scan.updateType('18.3.1', '19.2.0')).toBe('major');
    expect(scan.updateType('19.1.0', '19.2.0')).toBe('minor');
    expect(scan.updateType('19.2.0', '19.2.3')).toBe('patch');
    expect(scan.updateType('19.2.0', '19.2.0')).toBeNull();
    expect(scan.updateType('20.0.0', '19.2.0')).toBeNull();
  });

  it('looks up latest stable releases on npm, PyPI and Packagist for direct dependencies only', async () => {
    const files = new Map([
      ['package.json', JSON.stringify({ dependencies: { react: '^18.3.1', 'left-pad': '1.3.0' }, devDependencies: { '@types/node': '24.0.0' } })],
      ['requirements.txt', 'Django==5.1.4\n'],
      ['composer.json', JSON.stringify({ require: { 'laravel/framework': '^11.0' } })],
      ['composer.lock', JSON.stringify({ packages: [{ name: 'laravel/framework', version: 'v11.9.0' }, { name: 'symfony/console', version: 'v7.1.0' }] })],
    ]);
    const deps = scan.parseDependencies(files);
    expect(deps.find((d) => d.name === 'laravel/framework')?.direct).toBe(true);
    expect(deps.find((d) => d.name === 'symfony/console')?.direct).toBe(false);

    const { asked, fetchImpl } = fakeRegistries();
    const r = await scan.scanDependencies(deps, { osvUrl: '', fetchImpl, registries: { npm: 'http://npm/', pypi: 'http://pypi', packagist: 'http://packagist' } });
    const latest = Object.fromEntries(r.inventory.map((d) => [d.name, d.latest]));
    expect(latest).toMatchObject({ react: '19.2.0', '@types/node': '24.1.0', 'left-pad': null, django: '5.2.1', 'laravel/framework': '12.1.0', 'symfony/console': null });
    // Transitive packages are never looked up, release candidates never count as "latest".
    expect(asked.some((u) => u.includes('symfony'))).toBe(false);
    expect(r.findings.filter((f) => f.ruleId === 'dependency/outdated-major').map((f) => f.packageName).sort()).toEqual(['laravel/framework', 'react']);
    expect(r.notes).toContain('Çevrimiçi bağımlılık taraması kapalı (OSV_API_URL boş).');
  });

  it('makes no registry calls when registries are not configured (offline installs)', async () => {
    const { asked, fetchImpl } = fakeRegistries();
    const r = await scan.scanDependencies(scan.parseDependencies(new Map([['package.json', JSON.stringify({ dependencies: { react: '18.3.1' } })]])), { osvUrl: '', fetchImpl });
    expect(asked).toEqual([]);
    expect(r.inventory).toEqual([expect.objectContaining({ name: 'react', latest: null, direct: true })]);
  });
});
