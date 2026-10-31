import { describe, it, expect } from 'vitest';
import { pageOf, likeOf } from '../../src/lib/paging';

describe('list paging parameters', () => {
  const p = (q: string) => pageOf(new URLSearchParams(q));
  it('defaults to 100 from the start when nothing is given', () => expect(p('')).toEqual({ limit: 100, offset: 0 }));
  it('caps the page size and floors offset at zero', () => {
    expect(p('limit=100000')).toEqual({ limit: 500, offset: 0 });
    expect(p('limit=0&offset=-5')).toEqual({ limit: 1, offset: 0 });
    expect(p('limit=abc&offset=1.5')).toEqual({ limit: 100, offset: 0 });
    expect(p('limit=25&offset=50')).toEqual({ limit: 25, offset: 50 });
  });
  it('escapes LIKE wildcards in search text', () => {
    expect(likeOf(' 50%_off\\ ')).toBe('%50\\%\\_off\\\\%');
  });
});
