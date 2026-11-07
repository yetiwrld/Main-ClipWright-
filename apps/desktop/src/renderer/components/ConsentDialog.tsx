import React, { useEffect, useState } from 'react';
import { Button, Dialog } from '@clipwright/design-system';
import { api, describeError } from '../api.js';
import type { ConsentPromptPayload } from '../global.js';

/**
 * SPEC 06 §8 — the permission dialog shown before anything leaves the computer.
 *
 * The wording comes from the main process (`buildPrompt`), so the dialog, the
 * Privacy list and the router cannot drift apart. Buttons are exactly the three
 * the spec names: Allow once / Always allow for this provider / Cancel.
 */
export function ConsentDialog({
  open,
  providerId,
  category,
  onClose,
  onGranted,
}: {
  open: boolean;
  providerId: string | null;
  category: 'transcript' | 'audio' | 'test_payload';
  onClose: () => void;
  onGranted: (scope: 'once' | 'always') => void;
}) {
  const [prompt, setPrompt] = useState<ConsentPromptPayload | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !providerId) return;
    let cancelled = false;
    setPrompt(null);
    setError('');
    void api
      .consentPrompt(providerId, category)
      .then((p) => !cancelled && setPrompt(p))
      .catch((err) => !cancelled && setError(describeError(err)));
    return () => {
      cancelled = true;
    };
  }, [open, providerId, category]);

  const decide = async (scope: 'once' | 'always') => {
    if (!providerId) return;
    setBusy(true);
    try {
      await api.grantConsent(providerId, category, scope);
      onGranted(scope);
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="Allow this?"
      onClose={onClose}
      maxWidth={520}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => void decide('once')} disabled={busy || !prompt}>
            Allow once
          </Button>
          <Button variant="primary" onClick={() => void decide('always')} disabled={busy || !prompt}>
            Always allow for this provider
          </Button>
        </div>
      }
    >
      {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--fs-sm)', marginBottom: 12 }}>{error}</p>}
      {!prompt && !error && (
        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>Preparing the details…</p>
      )}
      {prompt && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 'var(--fs-md)', color: 'var(--text-primary)', lineHeight: 'var(--lh-md)' }}>
            {prompt.message}
          </p>
          <dl
            style={{
              margin: 0,
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: '6px 12px',
              fontSize: 'var(--fs-sm)',
              color: 'var(--text-secondary)',
            }}
          >
            <dt style={{ color: 'var(--text-muted)' }}>Will send</dt>
            <dd style={{ margin: 0 }}>{prompt.sent}</dd>
            <dt style={{ color: 'var(--text-muted)' }}>Never sends</dt>
            <dd style={{ margin: 0 }}>{prompt.neverSent}</dd>
            <dt style={{ color: 'var(--text-muted)' }}>Address</dt>
            <dd style={{ margin: 0 }}>{prompt.host}</dd>
          </dl>
          <p style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            You can revoke this any time in Settings → Privacy. Nothing is sent until you choose.
          </p>
        </div>
      )}
    </Dialog>
  );
}
