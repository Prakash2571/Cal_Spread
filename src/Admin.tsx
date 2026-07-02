import { useState } from "react";
import { verifyAdminSecret, setAdminToken } from "./api.ts";

interface AdminProps {
  onAuthenticated: () => void;
}

export default function Admin({ onAuthenticated }: AdminProps) {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await verifyAdminSecret(secret);
      if (result.success && result.token) {
        setAdminToken(result.token);
        onAuthenticated();
      } else {
        setError("Invalid admin secret");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="admin-page">
      <div className="admin-card">
        <div className="brand-mark" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="#6366f1"
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
              fill="#6366f1"
              stroke="none"
            />
            <rect
              x="14"
              y="5"
              width="6"
              height="8"
              rx="1.2"
              fill="#6366f1"
              stroke="none"
            />
          </svg>
        </div>
        <h1>Admin Verification</h1>
        <p className="admin-subtitle">
          Enter the admin secret to access management features
        </p>

        <form onSubmit={handleVerify}>
          <input
            type="password"
            className="admin-input"
            placeholder="Enter admin secret"
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
            {loading ? "Verifying..." : "Verify"}
          </button>
        </form>
      </div>
    </div>
  );
}
