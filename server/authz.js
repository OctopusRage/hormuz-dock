/**
 * Ownership authorization for projects and static sites.
 *
 * An entity is "private" when its `private` flag is set. A private entity may
 * only be managed (mutated, or read in ways that expose secrets) by its creator
 * or an admin. Public entities stay manageable by any authenticated user, which
 * preserves the tool's original shared-playground behavior.
 *
 * Note: privacy governs *panel management only*. A published static site
 * (/_static_/<slug>/) and any reverse-proxy route (/_<slug>) stay public exactly
 * as before — privacy never touches the public serving path.
 */
export function canManage(entity, user) {
  if (!entity || !user) return false;
  if (user.role === 'admin') return true; // admins manage everything
  if (!entity.private) return true; // public → anyone authenticated
  return !!entity.createdBy && entity.createdBy === user.username; // else: creator only
}
