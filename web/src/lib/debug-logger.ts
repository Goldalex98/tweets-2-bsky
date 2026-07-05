const DEBUG_PREFIX = '[tweets-2-bsky:web]';

function describeTarget(target: EventTarget | null): string {
  if (!(target instanceof Element)) {
    return 'unknown-target';
  }

  const tagName = target.tagName.toLowerCase();
  const id = target.id ? `#${target.id}` : '';
  const className =
    typeof target.className === 'string' && target.className.trim().length > 0
      ? `.${target.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.')}`
      : '';

  return `${tagName}${id}${className}`;
}

const SENSITIVE_NAME_PATTERN = /password|token|secret|ct0|api.?key|credential/i;

function isSensitiveField(target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): boolean {
  if (target instanceof HTMLInputElement && target.type === 'password') {
    return true;
  }
  const label = `${target.name || ''} ${target.id || ''} ${
    target instanceof HTMLInputElement ? target.placeholder || '' : ''
  }`;
  return SENSITIVE_NAME_PATTERN.test(label);
}

function eventToPayload(event: Event): Record<string, unknown> {
  const target = event.target;
  const payload: Record<string, unknown> = {
    type: event.type,
    target: describeTarget(target),
    timestamp: new Date().toISOString(),
    path: window.location.pathname,
  };

  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    payload.name = target.name || undefined;
    // Never log credentials (app passwords, auth tokens, API keys) even in debug mode.
    payload.value = isSensitiveField(target) ? '[redacted]' : target.value;
  }

  if (event instanceof MouseEvent) {
    payload.button = event.button;
    payload.clientX = event.clientX;
    payload.clientY = event.clientY;
  }

  return payload;
}

export function setupBrowserDebugLogging(): void {
  const enabled = window.localStorage.getItem('debug-browser-events') === '1';
  if (!enabled) {
    return;
  }

  const events = ['click', 'change', 'input', 'submit'];

  events.forEach((eventName) => {
    document.addEventListener(
      eventName,
      (event) => {
        console.debug(`${DEBUG_PREFIX} ui-event`, eventToPayload(event));
      },
      true,
    );
  });

  window.addEventListener('focus', () => {
    console.debug(`${DEBUG_PREFIX} window-focus`, { timestamp: new Date().toISOString() });
  });

  window.addEventListener('blur', () => {
    console.debug(`${DEBUG_PREFIX} window-blur`, { timestamp: new Date().toISOString() });
  });

  document.addEventListener('visibilitychange', () => {
    console.debug(`${DEBUG_PREFIX} visibility`, {
      state: document.visibilityState,
      timestamp: new Date().toISOString(),
    });
  });

  window.addEventListener('popstate', () => {
    console.debug(`${DEBUG_PREFIX} popstate`, {
      path: window.location.pathname,
      timestamp: new Date().toISOString(),
    });
  });

  console.info(`${DEBUG_PREFIX} verbose browser event logging enabled`);
}
