import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../ErrorBoundary';
import { Button } from './Button';
import { Input } from './Input';
import { Modal } from './Modal';
import { ToastProvider, useToast } from './Toast';

describe('ui primitives', () => {
  it('Button disables itself and exposes busy state while loading', () => {
    render(<Button loading>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
  });

  it('Input links its label and announces errors', () => {
    render(<Input label="Pincode" error="Enter a 6-digit pincode" />);
    expect(screen.getByLabelText('Pincode')).toHaveAttribute('aria-invalid', 'true');
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
