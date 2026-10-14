import { useEffect, useState } from 'react';

import { isLocalAsrAvailable } from '../../../services/voiceInput';

/**
 * Tracks whether the bundled local SenseVoice sidecar is usable (FR-3.6).
 *
 * Resolved once on mount. When unavailable the voice button is greyed out so the
 * user is not offered a control that cannot work.
 */
export const useVoiceInputAvailability = (): boolean => {
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void isLocalAsrAvailable().then((result) => {
      if (!cancelled) setAvailable(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return available;
};
