import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import type { RecommendedProduct } from './types';

/** Explicit confirmation required before any cart change. Closing or "Not now" makes no API call. */
export function AddToCartDialog({
  product,
  busy,
  onConfirm,
  onCancel,
}: {
  product: RecommendedProduct | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={product !== null} title="Add this item to your cart?" onClose={onCancel}>
      {product && (
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            <span className="font-semibold">{product.name}</span> (quantity 1) will be added to your cart. Nothing is ordered or paid
            for until you check out.
          </p>
          <div className="flex flex-wrap justify-end gap-3">
            <Button variant="secondary" onClick={onCancel} disabled={busy}>
              Not now
            </Button>
            <Button onClick={onConfirm} loading={busy}>
              Yes, add to cart
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
