import type { AppStateStatus } from 'react-native';

/** Clear temporary business reports when a native app enters the background. */
export function watchReportLifecycle(
  subscribe: (listener: (state: AppStateStatus) => void) => { remove: () => void },
  onBackground: () => void,
  onActive?: () => void,
): () => void {
  let listening = true;
  const subscription = subscribe((state) => {
    if (!listening) return;
    if (state === 'background') onBackground();
    else if (state === 'active') onActive?.();
  });
  return () => {
    listening = false;
    subscription.remove();
  };
}
