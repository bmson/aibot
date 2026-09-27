import { describe, expect, it } from 'vitest';
import {
  flightActivityState,
  flightAlert,
  flightAlertBasis,
  flightStateFingerprint,
  normalizeFlight,
} from './index.js';

const raw = {
  ident_iata: 'FI614',
  fa_flight_id: 'ICE614-1759300000-schedule-0001',
  origin: { code_iata: 'KEF', city: 'Reykjavik', timezone: 'Atlantic/Reykjavik' },
  destination: { code_iata: 'JFK', city: 'New York', timezone: 'America/New_York' },
  gate_origin: 'D4',
  terminal_origin: '1',
  departure_delay: 0,
  scheduled_out: '2026-10-02T16:40:00Z',
  scheduled_in: '2026-10-02T22:25:00Z',
};

function flight(overrides: Record<string, unknown> = {}) {
  const value = normalizeFlight({ ...raw, ...overrides });
  if (!value) throw new Error('fixture did not normalise');
  return value;
}

describe('flightActivityState', () => {
  it('is the iOS ContentState, key for key, with plain numbers for time', () => {
    const now = new Date('2026-10-02T15:00:00Z');
    expect(flightActivityState(flight(), now)).toEqual({
      phase: 'scheduled',
      statusText: 'On time',
      departEpoch: Date.parse('2026-10-02T16:40:00Z') / 1000,
      departOffset: 0,
      arriveEpoch: Date.parse('2026-10-02T22:25:00Z') / 1000,
      arriveOffset: -4 * 3600,
      gate: 'D4',
      terminal: '1',
      arrivalGate: '',
      baggage: '',
      updatedEpoch: now.getTime() / 1000,
    });
  });

  it('fingerprints what the owner sees, not when it was read', () => {
    const a = flightActivityState(flight(), new Date('2026-10-02T15:00:00Z'));
    const b = flightActivityState(flight(), new Date('2026-10-02T15:02:00Z'));
    const moved = flightActivityState(
      flight({ gate_origin: 'D6' }),
      new Date('2026-10-02T15:02:00Z'),
    );
    expect(flightStateFingerprint(a)).toBe(flightStateFingerprint(b));
    expect(flightStateFingerprint(a)).not.toBe(flightStateFingerprint(moved));
  });
});

describe('flightAlert', () => {
  const basis = flightAlertBasis(flight());

  it('stays quiet on a first read and on small drift', () => {
    expect(flightAlert('FI614', undefined, basis)).toBeUndefined();
    expect(
      flightAlert('FI614', basis, flightAlertBasis(flight({ departure_delay: 600 }))),
    ).toBeUndefined();
  });

  it('speaks up for a new gate, a real delay, and a cancellation', () => {
    expect(flightAlert('FI614', basis, flightAlertBasis(flight({ gate_origin: 'D6' })))).toEqual({
      title: 'FI614 gate change',
      body: 'Now departing from gate D6.',
    });
    expect(
      flightAlert('FI614', basis, flightAlertBasis(flight({ departure_delay: 1800 })))?.title,
    ).toBe('FI614 delayed');
    expect(flightAlert('FI614', basis, flightAlertBasis(flight({ cancelled: true })))?.title).toBe(
      'FI614 cancelled',
    );
  });
});
