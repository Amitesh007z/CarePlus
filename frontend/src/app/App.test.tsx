import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { ToastProvider, useToast } from '../components/ui/Toast';
import { routes } from './routes';

afterEach(() => vi.unstubAllGlobals());

const okPing = () =>
  Promise.resolve(
    new Response(JSON.stringify({ success: true, data: { message: 'pong', time: '2026-01-01T10:00:00Z' }, requestId: 'r' }), { status: 200 }),
  );

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
}

describe('application shell', () => {
  it('renders header, navigation and the connected API status', async () => {
    vi.stubGlobal('fetch', vi.fn(okPing));
    renderAt('/');
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(await screen.findByText(/Connected\./)).toBeInTheDocument();
  });

  it('shows an error with retry when the API is unreachable, then recovers', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('down')).mockImplementation(okPing);
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/');
    expect(await screen.findByRole('alert')).toHaveTextContent(/Unable to reach the server/);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Connected\./)).toBeInTheDocument();
  });

  it('renders the not-found page for unknown routes', async () => {
    vi.stubGlobal('fetch', vi.fn(okPing));
    renderAt('/does-not-exist');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
  });
});

describe('ui primitives', () => {
  it('Button disables itself and exposes busy state while loading', () => {
    render(<Button loading>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
  });

  it('Input links its label and announces errors', () => {
    render(<Input label="Pincode" error="Enter a 6-digit pincode" />);
    const input = screen.getByLabelText('Pincode');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a 6-digit pincode');
  });

  it('Modal is a labelled dialog that closes on Escape', async () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <Modal open={open} title="Confirm" onClose={() => setOpen(false)}>
          body
        </Modal>
      );
    }
    render(<Host />);
    expect(screen.getByRole('dialog', { name: 'Confirm' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('Toast shows a notification and can be dismissed', async () => {
    function Host() {
      const { notify } = useToast();
      return <button onClick={() => notify('success', 'Saved!')}>go</button>;
    }
    render(
      <ToastProvider>
        <Host />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByText('go'));
    expect(screen.getByRole('status')).toHaveTextContent('Saved!');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByText('Saved!')).not.toBeInTheDocument();
  });

  it('ErrorBoundary shows a safe fallback without the error message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Boom(): never {
      throw new Error('secret internals');
    }
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.queryByText(/secret internals/)).not.toBeInTheDocument();
    spy.mockRestore();
  });
});
