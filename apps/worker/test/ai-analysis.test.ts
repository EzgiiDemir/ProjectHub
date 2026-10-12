import { describe, expect, it } from 'vitest';
import { normalizeAnalysis } from '../src/jobs/ai.js';

describe('analysis result normalization', () => {
  it('keeps the requested shape as is', () => {
    expect(normalizeAnalysis({ summary: 'Özet', findings: ['a', 'b'] })).toEqual({ summary: 'Özet', findings: ['a', 'b'] });
  });

  it('flattens object findings that small local models return', () => {
    // Shape actually returned by qwen3:8b for a feedback triage (2026-10-09).
    const raw = {
      summary: 'Mobil cihazlarda Kayıt butonu ekranın dışında görünüyor.',
      findings: [
        { actionable_item: 'Mobil uyumluluk sorunu', evidence: 'app/page.jsx:12', risk: 'orta', next_step: 'flex-wrap ekleyin' },
        { item: 'Kabul kriteri', details: ['390px genişlikte buton görünür', 'yatay kaydırma yok'] },
      ],
    };
    expect(normalizeAnalysis(raw)).toEqual({
      summary: 'Mobil cihazlarda Kayıt butonu ekranın dışında görünüyor.',
      findings: ['Mobil uyumluluk sorunu — app/page.jsx:12 — orta — flex-wrap ekleyin', 'Kabul kriteri — 390px genişlikte buton görünür; yatay kaydırma yok'],
    });
  });

  it('rejects results without a summary or findings', () => {
    expect(normalizeAnalysis(null)).toBeNull();
    expect(normalizeAnalysis({ summary: 'x', findings: [] })).toBeNull();
    expect(normalizeAnalysis({ findings: ['a'] })).toBeNull();
    expect(normalizeAnalysis(['a'])).toBeNull();
  });
});
