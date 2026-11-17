import { RX_STATUS_STYLE, type RxStatus } from './types';

export function RxStatusPill({ status }: { status: RxStatus }) {
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${RX_STATUS_STYLE[status].tone}`}>
      {RX_STATUS_STYLE[status].label}
    </span>
  );
}
