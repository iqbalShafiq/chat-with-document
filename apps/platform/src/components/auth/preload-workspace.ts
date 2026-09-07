/**
 * Warm the Home route chunk while the user is still on login/register.
 * Submit is a <button>, so defaultPreload: "intent" never fetches `/`.
 *
 * Uses loadRouteChunk (not preloadRoute) so we don't run Home's beforeLoad,
 * which would getSession and redirect back to login.
 */
export function preloadWorkspaceRoute<TRoute>(router: {
  routesByPath: { "/"?: TRoute };
  loadRouteChunk: (route: TRoute) => unknown;
}): Promise<unknown> {
  const route = router.routesByPath["/"];
  if (!route) return Promise.resolve();
  return Promise.resolve(router.loadRouteChunk(route));
}
