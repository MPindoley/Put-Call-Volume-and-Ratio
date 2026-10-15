import { describe, expect, it } from 'vitest';
import { maintenanceWindow } from './history-jobs';

// Wednesday 2026-10-14 (EDT, UTC−4); Saturday 2026-10-17; Thanksgiving 2026-11-26 (EST, UTC−5).
describe('maintenanceWindow', () => {
  it('runs on a trading day from 9:00 to 21:00 ET', () => {
    expect(maintenanceWindow(new Date('2026-10-14T13:00:00Z'))).toBe(true); // 9:00 ET
    expect(maintenanceWindow(new Date('2026-10-14T22:11:00Z'))).toBe(true); // 18:11 ET, after the capture
    expect(maintenanceWindow(new Date('2026-10-15T00:59:00Z'))).toBe(true); // 20:59 ET
  });

  it('stays idle overnight, at weekends and on holidays', () => {
    expect(maintenanceWindow(new Date('2026-10-14T12:59:00Z'))).toBe(false); // 8:59 ET
    expect(maintenanceWindow(new Date('2026-10-15T01:00:00Z'))).toBe(false); // 21:00 ET
    expect(maintenanceWindow(new Date('2026-10-15T06:11:00Z'))).toBe(false); // 2:11 ET
    expect(maintenanceWindow(new Date('2026-10-17T16:11:00Z'))).toBe(false); // Saturday noon
    expect(maintenanceWindow(new Date('2026-11-26T17:11:00Z'))).toBe(false); // Thanksgiving noon
  });
});
