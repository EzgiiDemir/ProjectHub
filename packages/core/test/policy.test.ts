import { describe, expect, it } from 'vitest';
import { deploymentWindowSchema } from '@projecthub/contracts';
import { deploymentWindowDecision, isWithinDeploymentWindow } from '../src/index.js';

const office = deploymentWindowSchema.parse({ enabled: true, days: [1, 2, 3, 4, 5], start: '09:00', end: '22:00', timezone: 'Europe/Istanbul', outside: 'require_approval' });
// Istanbul is UTC+3 all year.
const ist = (iso: string) => new Date(`${iso}+03:00`);

describe('deployment window policy', () => {
  it('evaluates the window in its own time zone', () => {
    expect(isWithinDeploymentWindow(office, ist('2026-10-08T09:00:00'))).toBe(true); // Thursday 09:00
    expect(isWithinDeploymentWindow(office, ist('2026-10-08T21:59:00'))).toBe(true);
    expect(isWithinDeploymentWindow(office, ist('2026-10-08T22:00:00'))).toBe(false); // "after 22:00"
    expect(isWithinDeploymentWindow(office, ist('2026-10-08T08:59:00'))).toBe(false);
    expect(isWithinDeploymentWindow(office, ist('2026-10-10T12:00:00'))).toBe(false); // Saturday
    // 20:30 UTC is already 23:30 in Istanbul.
    expect(isWithinDeploymentWindow(office, new Date('2026-10-08T20:30:00Z'))).toBe(false);
  });

  it('assigns overnight windows to the day they start on', () => {
    const night = deploymentWindowSchema.parse({ enabled: true, days: [5], start: '22:00', end: '06:00', timezone: 'Europe/Istanbul', outside: 'deny' });
    expect(isWithinDeploymentWindow(night, ist('2026-10-09T23:00:00'))).toBe(true); // Friday night
    expect(isWithinDeploymentWindow(night, ist('2026-10-10T05:59:00'))).toBe(true); // early Saturday
    expect(isWithinDeploymentWindow(night, ist('2026-10-10T06:00:00'))).toBe(false);
    expect(isWithinDeploymentWindow(night, ist('2026-10-09T05:00:00'))).toBe(false); // early Friday belongs to Thursday
  });

  it('decides per environment type and never denies rollbacks', () => {
    const settings = { deploymentWindow: { ...office, outside: 'deny' } };
    const night = ist('2026-10-08T23:30:00');
    expect(deploymentWindowDecision(settings, 'staging', { at: night })).toEqual({ status: 'not_applicable' });
    expect(deploymentWindowDecision(settings, 'production', { at: ist('2026-10-08T10:00:00') })).toEqual({ status: 'inside' });
    expect(deploymentWindowDecision(settings, 'production', { at: night })).toMatchObject({ status: 'outside', action: 'deny' });
    expect(deploymentWindowDecision(settings, 'production', { at: night, isRollback: true })).toMatchObject({ status: 'outside', action: 'require_approval' });
    const msg = deploymentWindowDecision(settings, 'production', { at: night });
    expect(msg.status === 'outside' && msg.message).toContain('Pazartesi, Salı, Çarşamba, Perşembe, Cuma 09:00–22:00 (Europe/Istanbul)');
    expect(deploymentWindowDecision({ deploymentWindow: { ...office, enabled: false } }, 'production', { at: night })).toEqual({ status: 'not_applicable' });
    expect(deploymentWindowDecision({}, 'production', { at: night })).toEqual({ status: 'not_applicable' });
  });

  it('rejects invalid windows', () => {
    expect(deploymentWindowSchema.safeParse({ ...office, timezone: 'Mars/Olympus' }).success).toBe(false);
    expect(deploymentWindowSchema.safeParse({ ...office, start: '25:00' }).success).toBe(false);
    expect(deploymentWindowSchema.safeParse({ ...office, end: '09:00' }).success).toBe(false);
    expect(deploymentWindowSchema.safeParse({ ...office, days: [] }).success).toBe(false);
  });
});
