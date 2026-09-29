'use client';

import { useState, useTransition } from 'react';
import { btnSm } from '@/lib/ui';
import { ActionButton } from '@/lib/ui-client';
import { removeKnowledgeConnection } from './actions';

export function RemoveConnection({
  relationId,
  sentence,
  onRemoved,
}: {
  relationId: string;
  sentence: string;
  onRemoved?: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  return (
    <div className="min-w-0 text-xs">
      {confirm ? (
        <div className="max-w-sm rounded-lg border border-edge bg-raised p-3">
          <p className="text-sm text-strong">Remove this connection?</p>
          <p className="mt-1 text-muted">{sentence}</p>
          <p className="mt-1 text-muted">
            Removes this claim from the graph. The original note and other supporting claims stay
            saved.
          </p>
          <div className="mt-2 flex gap-2">
            <ActionButton
              variant="danger"
              size="sm"
              pending={pending}
              pendingLabel="Removing…"
              onClick={() =>
                startTransition(async () => {
                  setError('');
                  try {
                    const result = await removeKnowledgeConnection(relationId);
                    if (result.error) setError(result.error);
                    else {
                      setConfirm(false);
                      onRemoved?.();
                    }
                  } catch {
                    setError('Couldn’t remove the connection. Try again.');
                  }
                })
              }
            >
              Remove connection
            </ActionButton>
            <button
              type="button"
              className={btnSm.outline}
              disabled={pending}
              onClick={() => setConfirm(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className={btnSm.dangerOutline} onClick={() => setConfirm(true)}>
          Remove
        </button>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
