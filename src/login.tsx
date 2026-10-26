import { useState, type FormEvent } from 'react';
import { ErrorNotice } from './errorNotice';

export interface LoginScreenProps {
  engineLabel: string;
  reason: 'required' | 'expired';
  onSubmit: (user: string, password: string) => Promise<void>;
}

/**
 * Login form for engines that require a bearer token.
 *
 * `POST /v1/login` takes `{user, password}` and returns
 * `{token, user, roles, expiresAt}`. Wrong password and unknown user are
 * deliberately indistinguishable (401 "Invalid user name or password."), so the
 * form shows exactly that and does not guess which field was wrong.
 *
 * Developers can skip all of this by starting the engine with `-Anonymous`;
 * that is the engine's own supported development mode.
 */
export function LoginScreen({ engineLabel, reason, onSubmit }: LoginScreenProps) {
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(user.trim(), password);
    } catch (submitError) {
      setError(submitError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-area">
      <form className="login-card" data-testid="login-screen" onSubmit={(event) => void submit(event)}>
        <div className="login-head">
          <span className="brand-mark login-mark" aria-hidden="true">
            ▤
          </span>
          <div>
            <h2>Sign in</h2>
            <p className="muted login-engine">{engineLabel}</p>
          </div>
        </div>

        <p className="login-note">
          {reason === 'expired'
            ? 'Your session expired or the engine restarted. Sign in again — engine sessions live in memory, so a restart logs everyone out.'
            : 'This engine requires a bearer token. Sign in to browse its cubes and dimensions.'}
        </p>

        <label className="login-field">
          <span>User</span>
          <input
            data-testid="login-user"
            name="user"
            value={user}
            onChange={(event) => setUser(event.target.value)}
            autoComplete="username"
            autoFocus
            required
            disabled={busy}
          />
        </label>

        <label className="login-field">
          <span>Password</span>
          <input
            data-testid="login-password"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            disabled={busy}
          />
        </label>

        {error !== null && <ErrorNotice error={error} title="Sign-in failed" />}

        <button type="submit" className="btn btn-primary login-submit" data-testid="login-submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="hint login-hint">
          Development alternative: start the engine with <code>-Anonymous</code>. Users are created with{' '}
          <code>serve.exe --add-user &lt;name&gt; --role &lt;role&gt;</code>.
        </p>
      </form>
    </div>
  );
}
