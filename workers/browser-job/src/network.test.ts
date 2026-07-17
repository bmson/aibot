import { describe, expect, it } from 'vitest';
import { assertPublicHttpUrl, type HostResolver, isPublicAddress } from './network.js';

describe('browser egress policy', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '100.64.0.1',
    '169.254.169.254',
    '172.20.1.1',
    '192.168.1.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::2',
    '2001::1',
    '2002:7f00:1::',
  ])('blocks non-public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
    'allows public address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it.each(['192.1.2.3', '198.51.99.2', '203.0.112.4'])(
    'does not overblock public neighbors of reserved ranges: %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it.each(['192.0.2.3', '198.51.100.2', '203.0.113.4'])(
    'blocks documentation range %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(false);
    },
  );

  it('blocks private DNS answers and URL credentials', async () => {
    const privateResolver: HostResolver = async () => [{ address: '10.0.0.8', family: 4 }];
    await expect(assertPublicHttpUrl('https://example.com', privateResolver)).rejects.toThrow(
      /private/,
    );
    await expect(
      assertPublicHttpUrl('https://user:pass@example.com', privateResolver),
    ).rejects.toThrow(/credentials/);
    await expect(assertPublicHttpUrl('https://example.com:8443', privateResolver)).rejects.toThrow(
      /ports/,
    );
  });

  it('allows a hostname only when every DNS answer is public', async () => {
    const publicResolver: HostResolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ];
    await expect(
      assertPublicHttpUrl('https://example.com/path', publicResolver),
    ).resolves.toMatchObject({
      hostname: 'example.com',
    });
  });
});
