// 삼국지 일기토 - 서버 코드 (Cloudflare Worker)
// 1단계: 연결 확인용. /api/health 로 접속하면 금고(환경 변수) 설정 여부만 알려줍니다.
// 비밀 열쇠 값은 절대 화면에 내보내지 않습니다.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return Response.json({
        ok: true,
        has_url: Boolean(env.SUPABASE_URL),
        has_key: Boolean(env.SUPABASE_SECRET_KEY),
      });
    }

    // 그 외 모든 주소는 기존처럼 게임 파일을 보여줍니다.
    return env.ASSETS.fetch(request);
  },
};
