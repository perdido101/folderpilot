/** Navigate from outside React components (toasts, background jobs). The router registers itself on start. */
let navigator: ((path: string) => void) | null = null;

export function setNavigator(fn: (path: string) => void) {
  navigator = fn;
}

export function navigateTo(path: string) {
  if (navigator) navigator(path);
  else window.location.assign(path);
}
