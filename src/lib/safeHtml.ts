// safeHtml — dangerouslySetInnerHTML 로 넣기 전 신뢰불가 HTML 을 정화한다.
//
// marked 로 렌더한 마크다운(= LLM 출력 / 채팅 메시지 / 스크랩한 웹·파일 콘텐츠)을
// 그대로 __html 에 넣으면 <script>·onerror·javascript: URL 같은 페이로드가 렌더러
// 에서 실행된다. contextIsolation/sandbox 가 시스템 직접 접근은 막지만, 실행된
// JS 는 여전히 window.twixy.* IPC 를 부르고 Supabase 세션 토큰을 읽어 유출할 수
// 있다. DOMPurify 로 스크립트/이벤트 핸들러/위험 URL 을 제거하고 정상 서식
// (제목·목록·링크·코드·표)은 유지한다.
//
// 렌더러(브라우저) 전용 — DOMPurify 는 실제 DOM 이 있어야 동작한다.
import DOMPurify from 'dompurify'

/** 신뢰불가 HTML 문자열을 정화해 반환. 문자열이 아니면 빈 문자열. */
export function safeHtml(html: unknown): string {
  return DOMPurify.sanitize(typeof html === 'string' ? html : '')
}
