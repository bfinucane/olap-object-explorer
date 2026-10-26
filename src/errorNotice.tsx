import { errorCode, errorText } from './api';

interface ErrorNoticeProps {
  error: unknown;
  title?: string;
  onRetry?: () => void;
}

/**
 * Every engine error the explorer can surface: the engine is informative
 * (`{"error": "...", "code": "unknown_dataset"}`), so both parts are shown
 * verbatim (handoff §6: "show `code` and `error`").
 */
export function ErrorNotice({ error, title, onRetry }: ErrorNoticeProps) {
  const code = errorCode(error);
  return (
    <div className="error-notice" role="alert">
      <div className="error-title">
        {title ?? 'Request failed'}
        {code !== null && <code className="error-code">{code}</code>}
      </div>
      <p className="error-message">{errorText(error)}</p>
      {onRetry !== undefined && (
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
