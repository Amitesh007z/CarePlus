import { useMemo } from 'react';
import { createBrowserRouter, RouterProvider, type RouteObject } from 'react-router-dom';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { ToastProvider } from '../components/ui/Toast';
import { routes as defaultRoutes } from './routes';

export function App({ routes = defaultRoutes }: { routes?: RouteObject[] }) {
  const router = useMemo(() => createBrowserRouter(routes), [routes]);
  return (
    <ErrorBoundary>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </ErrorBoundary>
  );
}
