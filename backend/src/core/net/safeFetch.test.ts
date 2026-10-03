/**
 * safeFetch tests — offline only (no network).
 * Rejection paths use IP literals so no DNS lookup happens.
 */
import {
  readPublicResource,
  sanitizeHeaders,
} from './safeFetch';

describe('sanitizeHeaders', () => {
  it('strips sensitive headers and keeps the rest', () => {
    const out = sanitizeHeaders({
      'content-type': 'text/html',
      'set-cookie': 'a=b',
      location: 'https://example.com/',
      'X-Custom': ['1', '2'],
      'Content-Length': '10',
    });
    expect(out).toEqual({
      'content-type': 'text/html',
      'X-Custom': '1, 2',
    });
  });
});

describe('readPublicResource guard rails', () => {
  it('blocks private IPv4 literals without network', async () => {
    await expect(readPublicResource('http://10.0.0.1/')).rejects.toThrow();
  });

  it('blocks loopback without network', async () => {
    await expect(readPublicResource('http://127.0.0.1:8787/api/health')).rejects.toThrow();
  });

  it('blocks localhost without network', async () => {
    await expect(readPublicResource('http://localhost:8787/')).rejects.toThrow();
  });

  it('blocks non-HTTP protocols without network', async () => {
    await expect(readPublicResource('ftp://example.com/file')).rejects.toThrow();
  });

  it('blocks non-standard ports without network', async () => {
    await expect(readPublicResource('http://93.184.216.34:8080/')).rejects.toThrow();
  });
});
