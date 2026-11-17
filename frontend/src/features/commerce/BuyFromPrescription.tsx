import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShoppingCart } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { apiRequest } from '../../lib/api';
import { messageOf } from '../../lib/useApi';

/**
 * Adds the prescription's exact medicines and quantities to the cart. The client sends only the prescription id;
 * the server reads the items itself and re-checks ownership, status, expiry and prior fulfilment.
 */
export function BuyFromPrescription({ rxId, status, pharmacyOpen }: { rxId: string; status: string; pharmacyOpen: boolean }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status !== 'ISSUED' || pharmacyOpen) return null;

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/api/v1/patients/me/cart/prescriptions/${rxId}`, { method: 'POST' });
      navigate('/cart');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Buy these medicines" description="Adds exactly the medicines and quantities on this prescription to your cart. Quantities cannot be changed.">
      {error && <p role="alert" className="mb-4 text-sm text-rose-700">{error}</p>}
      <Button onClick={buy} loading={busy}>
        <ShoppingCart className="size-4" aria-hidden="true" /> Buy these medicines
      </Button>
    </Card>
  );
}
