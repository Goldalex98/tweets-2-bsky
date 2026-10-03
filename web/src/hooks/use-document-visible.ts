import { useEffect, useState } from 'react';

const isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** Tracks whether the dashboard tab is in front, so background tabs can stop polling. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(isVisible);
  useEffect(() => {
    const update = () => setVisible(isVisible());
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}
