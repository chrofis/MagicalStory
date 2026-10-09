import React from 'react';
import { reportError } from '@/services/errorReporter';

interface Props {
  /** Where it sits, for the server log ("TrialBook"). */
  area: string;
  title: string;
  retryLabel: string;
  children: React.ReactNode;
}

/**
 * A render error under this boundary shows a retry button instead of unmounting the whole page
 * (React's default: a white page and a manual reload). The error goes to /api/log-error so the
 * server log shows what threw. It is a safety net, not a substitute for fixing the throw
 * (trial viewer white page, 2026-10-09).
 */
export default class RenderErrorBoundary extends React.Component<Props, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    void reportError({
      message: `Render error in ${this.props.area}: ${error instanceof Error ? error.message : String(error)}`,
      errorType: 'RenderError',
      error,
      context: { area: this.props.area, componentStack: (info.componentStack || '').slice(0, 300) },
    });
  }

  render() {
    if (this.state.failed) {
      return (
        <div role="alert" className="text-center py-8">
          <p className="text-gray-700 font-medium mb-3">{this.props.title}</p>
          <button
            type="button"
            onClick={() => this.setState(s => ({ failed: false, attempt: s.attempt + 1 }))}
            className="text-indigo-500 hover:text-indigo-800 font-medium text-sm"
          >
            {this.props.retryLabel}
          </button>
        </div>
      );
    }
    // The attempt in the key remounts the subtree on a retry: a fresh DOM, not the one that threw.
    return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
  }
}
