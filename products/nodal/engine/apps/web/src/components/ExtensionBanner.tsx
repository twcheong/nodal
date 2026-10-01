import type { ExtensionFailure } from "../extensions/loader";

export function ExtensionBanner({
  failures,
  onDismiss,
}: {
  failures: readonly ExtensionFailure[];
  onDismiss?: () => void;
}): React.JSX.Element | null {
  if (failures.length === 0) return null;

  return (
    <section className="extension-banner" role="alert" aria-label="확장 로드 실패">
      <header>
        <strong>일부 확장을 불러오지 못했습니다</strong>
        {onDismiss ? (
          <button type="button" aria-label="확장 오류 닫기" onClick={onDismiss}>
            ×
          </button>
        ) : null}
      </header>
      <ul>
        {failures.map(({ extension, reason, source }) => (
          <li key={`${source}:${extension.id}`}>
            <b>{extension.name}</b>
            <code>{extension.id}</code>
            <span>{reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
