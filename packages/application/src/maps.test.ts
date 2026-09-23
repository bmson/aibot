import { describe, expect, it } from 'vitest';
import { parseRouteSnapshotQuery } from './maps.js';

describe('parseRouteSnapshotQuery', () => {
  const ok = {
    from: '37.7857,-122.4011',
    to: '37.7786,-122.3893',
    line: '_p~iF~ps|U',
    scheme: 'dark',
  };
  it('accepts coordinates and an encoded line', () => {
    expect(parseRouteSnapshotQuery(new URLSearchParams(ok))).toEqual({
      from: { lat: 37.7857, lng: -122.4011 },
      to: { lat: 37.7786, lng: -122.3893 },
      line: '_p~iF~ps|U',
      scheme: 'dark',
    });
  });
  it.each([
    { from: '999,1' },
    { to: 'Oracle Park' },
    { line: 'has spaces in it' },
    { line: 'a'.repeat(2001) },
  ])('rejects %o', (bad) => {
    expect(parseRouteSnapshotQuery(new URLSearchParams({ ...ok, ...bad }))).toBeUndefined();
  });
});
