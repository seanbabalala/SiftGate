import { ForbiddenException } from '@nestjs/common';
import { intersectPermissionScopes } from '../../src/auth/permission-scopes';

describe('Effective permission scopes', () => {
  it('preserves unrestricted configuration, deduplicates and intersects all constrained scopes', () => {
    expect(intersectPermissionScopes([], [])).toEqual([]);
    expect(intersectPermissionScopes([], ['a', 'a', 'b'], ['b', 'c'])).toEqual([
      'b',
    ]);
    expect(intersectPermissionScopes(['a'], [])).toEqual(['a']);
  });
  it('never treats an empty intersection as unrestricted, including a third namespace scope', () => {
    expect(() => intersectPermissionScopes(['a'], ['b'])).toThrow(
      ForbiddenException,
    );
    expect(() =>
      intersectPermissionScopes(['a', 'b'], ['b', 'c'], ['c']),
    ).toThrow(ForbiddenException);
  });
});
