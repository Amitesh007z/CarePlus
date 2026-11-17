import { useState } from 'react';
import { useToast } from '../../components/ui/Toast';
import { downloadFile } from '../../lib/download';
import { messageOf } from '../../lib/useApi';

export function usePdfDownload() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function download(path: string, rxNumber: string | null) {
    setBusy(true);
    try {
      await downloadFile(path, `${rxNumber ?? 'prescription'}.pdf`);
    } catch (err) {
      toast.notify('error', messageOf(err));
    } finally {
      setBusy(false);
    }
  }
  return { busy, download };
}
