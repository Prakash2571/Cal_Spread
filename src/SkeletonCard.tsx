/** Shimmering placeholder card shown while the F&O board is loading. */
export default function SkeletonCard() {
  return (
    <article className="card skeleton" aria-hidden="true">
      <header className="card-head">
        <div className="card-title">
          <span className="sk sk-symbol" />
          <span className="sk sk-name" />
        </div>
        <span className="sk sk-price" />
      </header>

      <table className="card-table">
        <tbody>
          {[68, 52, 58, 46].map((w, i) => (
            <tr key={i}>
              <td>
                <span className="sk sk-row" style={{ width: `${w}%` }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}
