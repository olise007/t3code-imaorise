import { useId, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

/** Mounted for one rename attempt so cancel always discards the draft. */
export function RenameConnectionDialog({
  name,
  onSave,
  onClose,
}: {
  readonly name: string;
  readonly onSave: (label: string) => Promise<string | null>;
  readonly onClose: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const save = async () => {
    if (pending.current) return;
    const label = draft.trim();
    if (!label) {
      setError("Connection name cannot be empty.");
      return;
    }
    pending.current = true;
    setSaving(true);
    try {
      const failure = await onSave(label);
      if (failure === null) onClose();
      else setError(failure);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rename connection.");
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending.current) onClose();
      }}
    >
      <DialogPopup showCloseButton={!saving}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename connection</DialogTitle>
            <DialogDescription>This name is used everywhere on this device.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label htmlFor={id}>Connection name</label>
            <Input
              id={id}
              autoFocus
              value={draft}
              disabled={saving}
              aria-invalid={error !== null}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
            />
            {error ? (
              <p id={`${id}-error`} role="alert">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
