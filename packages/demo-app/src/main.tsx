import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRootRoute, createRoute, createRouter, Outlet, Link } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Users } from './Users';

export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } });

const rootRoute = createRootRoute({
  component: () => (
    <div className="shell">
      <nav>
        <Link to="/" data-testid="nav-home">Home</Link> · <Link to="/users" search={{ page: 1 }} data-testid="nav-users">Users</Link>
      </nav>
      <Outlet />
    </div>
  ),
});
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: App });
const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/users',
  validateSearch: (s: Record<string, unknown>) => ({ page: Number(s.page ?? 1) }),
  component: Users,
});
const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, usersRoute]) });
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// window.__TANSTACK_QUERY_CLIENT__ / __TANSTACK_ROUTER__ are set by the Agent Debug MCP Vite plugin (vite.config.ts).

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
