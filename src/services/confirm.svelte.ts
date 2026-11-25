// In-app confirmation prompts. Native confirm()/alert() are suppressed in some
// embedded browsers (they return false at once), which silently blocked
// actions such as "Discard and start new", so the app asks with its own dialog.

export const confirmState = $state({
  open: false,
  message: "",
  confirmLabel: "OK",
  danger: false,
  notice: false // a message with only an OK button
});

let resolver: ((confirmed: boolean) => void) | null = null;

export function askConfirm(message: string, options: { confirmLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  resolver?.(false);
  Object.assign(confirmState, {
    open: true,
    message,
    confirmLabel: options.confirmLabel ?? "OK",
    danger: options.danger ?? false,
    notice: false
  });
  return new Promise((resolve) => { resolver = resolve; });
}

export function showNotice(message: string): Promise<boolean> {
  resolver?.(false);
  Object.assign(confirmState, { open: true, message, confirmLabel: "OK", danger: false, notice: true });
  return new Promise((resolve) => { resolver = resolve; });
}

export function settleConfirm(confirmed: boolean) {
  if (!confirmState.open) return;
  confirmState.open = false;
  const resolve = resolver;
  resolver = null;
  resolve?.(confirmed);
}
