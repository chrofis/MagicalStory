import * as React from 'react';

interface CondProps {
  /** Placeholder name (without braces). Must match the key used in email.js values. */
  when: string;
  children: React.ReactNode;
}

/**
 * Wraps children in `{?key}...{/key}` marker strings so email.js can either
 * keep the inner content (when the placeholder value is truthy) or strip the
 * whole block (when it's empty / missing) at send time.
 *
 * The literal text "{?coverUrl}" / "{/coverUrl}" survives React rendering as
 * text nodes and gets caught by `fillTemplate`'s conditional regex.
 */
export function Cond({ when, children }: CondProps) {
  return (
    <>
      {`{?${when}}`}
      {children}
      {`{/${when}}`}
    </>
  );
}
