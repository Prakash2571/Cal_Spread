export default function BrandMark({ className = "" }: { className?: string }) {
  return (
    <span className={`brand-mark${className ? ` ${className}` : ""}`} aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M7 3v18M17 3v18" />
        <rect x="4" y="7" width="6" height="9" rx="1.2" fill="currentColor" stroke="none" />
        <rect x="14" y="5" width="6" height="8" rx="1.2" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}
