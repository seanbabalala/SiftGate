import { ForbiddenException } from '@nestjs/common';

/** Empty configured lists mean unrestricted, but a disjoint intersection must deny. */
export function intersectPermissionScopes(...scopes: string[][]): string[] {
  const constrained = scopes
    .map((scope) => [...new Set(scope.filter(Boolean))])
    .filter((scope) => scope.length > 0);
  if (constrained.length === 0) return [];
  const intersection = constrained.reduce((current, scope) => {
    const allowed = new Set(scope);
    return current.filter((value) => allowed.has(value));
  });
  if (intersection.length === 0) {
    throw new ForbiddenException(
      'API key, team, and namespace permissions have no overlap.',
    );
  }
  return intersection;
}
