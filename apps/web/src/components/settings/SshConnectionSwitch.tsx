import { useRef, useState, type ComponentProps } from "react";
import { Switch } from "../ui/switch";

/** Connection intent is distinct from the server and synchronized application status. */
export function SshConnectionSwitch({
  enabled,
  disabled,
  label,
  onChange,
  ...triggerProps
}: {
  enabled: boolean;
  disabled: boolean;
  label: string;
  onChange: (enabled: boolean) => Promise<boolean>;
} & Omit<ComponentProps<typeof Switch>, "onChange" | "disabled" | "checked" | "onCheckedChange">) {
  const active = useRef(false);
  const [pending, setPending] = useState(false);
  return (
    <Switch
      {...triggerProps}
      size="sm"
      checked={enabled}
      disabled={disabled || pending}
      aria-busy={pending}
      aria-label={`${pending ? "Updating connection to" : enabled ? "Disconnect from" : "Connect to"} ${label}`}
      onCheckedChange={async (checked) => {
        if (active.current) return;
        active.current = true;
        setPending(true);
        try {
          await onChange(checked);
        } finally {
          active.current = false;
          setPending(false);
        }
      }}
    />
  );
}
