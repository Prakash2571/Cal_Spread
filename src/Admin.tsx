import { useState } from "react";
import { setAdminToken } from "./api.ts";
import ThemeToggle from "./ThemeToggle.tsx";

interface AdminProps {
  onAuthenticated: () => void;
  /** The verify call for this route (full admin or trade access). */
  verify: (secret: string) => Promise<{ success: boolean; token: string }>;
  title?: string;
  subtitle?: string;
  placeholder?: string;
}

export default function Admin({
  onAuthenticated,
  verify,
  title = "Admin Verification",
  subtitle = "Enter the admin secret to access management features",
  placeholder = "Enter admin secret",
}: AdminProps) {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await verify(secret);
      if (result.success && result.token) {
        setAdminToken(result.token);
        onAuthenticated();
      } else {
        setError("Invalid code");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="admin-page">
      <ThemeToggle />
      <div className="admin-card">
        <div className="brand-mark" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="#ffffff"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M7 3v18M17 3v18" />
            <rect
              x="4"
              y="7"
              width="6"
              height="9"
              rx="1.2"
              fill="#ffffff"
              stroke="none"
            />
            <rect
              x="14"
              y="5"
              width="6"
              height="8"
              rx="1.2"
              fill="#ffffff"
              stroke="none"
            />
          </svg>
        </div>
        <h1>{title}</h1>
        <p className="admin-subtitle">{subtitle}</p>

        <form onSubmit={handleVerify}>
          <input
            type="password"
            className="admin-input"
            placeholder={placeholder}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            disabled={loading}
            autoFocus
          />

          {error && <div className="admin-error">{error}</div>}

          <button
            type="submit"
            className="btn btn--primary btn--full"
            disabled={loading || !secret.trim()}
          >
            {loading ? "Verifying…" : "Verify"}
          </button>
        </form>
      </div>
    </div>
  );
}
