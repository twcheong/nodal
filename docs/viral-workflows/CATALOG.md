# 바이럴 마케팅 워크플로우 100선 — 시스템 카탈로그

Twixy Marketing Copilot용 바이럴 마케팅 예제 워크플로우 100개. 무작위 나열이 아니라
**바이럴 루프 6단계(필러) × 채널** 매트릭스로 설계되어, 필러끼리 이어 붙이면
`리서치 → 벤치마크 → 전략 → 제작 → 확산 → 측정`의 완결된 그로스 루프가 된다.

## 시스템 구조

### 필러 (바이럴 루프 6단계)

| 필러 | 코드 | 개수 | 기본 태그 | 역할 |
|---|---|---|---|---|
| A. 시그널·트렌드 리서치 | `signal` | 18 | `research` | 지금 뜨는 것을 남보다 먼저 포착 |
| B. 경쟁·벤치마크 분석 | `bench` | 15 | `research` | 이미 터진 것을 해부해 공식 추출 |
| C. 바이럴 전략·기획 | `strategy` | 15 | `campaign` | 포착·해부 결과를 실행 가능한 플랜으로 |
| D. 콘텐츠 제작 (텍스트) | `create` | 22 | `content` | 스크립트·카피·원고 뱃치 생산 |
| E. 확산·실행 | `amplify` | 15 | `social` | 발행·참여·아웃리치 (chrome UI 자동화) |
| F. 측정·최적화 | `measure` | 15 | `reporting` | 성과 회수 → 훅/전략 라이브러리에 환류 |

### 채널 커버리지

Instagram(릴스·스토리·피드) · Threads · YouTube(롱폼·쇼츠) · X · TikTok ·
네이버(데이터랩·블로그·카페) · 한국 커뮤니티 · Reddit · 카카오톡 · 뉴스레터/이메일 ·
자사 사이트/SEO · 크로스채널

### 공통 규약

- **id**: `wf_viral_<필러>_<slug>` (아래 표의 slug 열 앞에 `wf_viral_` 프리픽스)
- **표준 입력 ID** (워크플로우 간 재사용): `brand_name`(text) · `niche`(text) ·
  `target_audience`(text) · `account_url`(url) · `competitor_urls`(list/url) ·
  `hashtags`(list/text) · `topic`(text) · `target_keyword`(query) · `draft_path`(path)
- **노드 패턴** — 리서치형: `수집(chrome/web-fetch) → validation → 분석(read) → 저장(write)` /
  실행형: `준비물 read → 실행(chrome) → 결과 자체 보고` (마지막 노드가 write면 type이
  research로 파생되므로, execution형은 chrome 노드로 끝낸다)
- **outputDir**: 원본 수집 → `data/raw/<platform>` · 분석/라이브러리 → `data/insights` ·
  전략/캘린더 → `strategies` · 원고 → `content/drafts` · 리포트 → `data/reports`
- **뱃치 한도**: 반복 작업은 노드당 10~15건 (노드 1턴 = 9분 제한)
- **안전 원칙**: 발행·댓글·DM 워크플로우는 라운드당 10~15건, 자사 계정 투명 운영,
  도배·스팸 금지 문구를 detail에 명시
- 이미지 생성·스크린샷 불가 → 모든 산출물은 텍스트(비주얼은 "촬영/디자인 지시문"으로 서술)
- 크론/스케줄 입력 금지 — 반복 실행은 앱 밖 스케줄러 영역

---

## A. 시그널·트렌드 리서치 (18) — 태그 `research`

| # | slug | 제목 — 설명 | 입력 | 노드 체인 → outputDir |
|---|---|---|---|---|
| 1 | `signal_ig_reels_trend` | IG 릴스 트렌드 포맷 스캔 — 니치 해시태그 상위 릴스의 포맷·훅 패턴 추출 | niche, hashtags | chrome(instagram) 수집 → validation → write(md) → `data/insights` |
| 2 | `signal_ig_hashtag_growth` | 니치 해시태그 성장 스냅샷 — 해시태그별 게시물 수·참여 기록 | hashtags | chrome(instagram) → write(csv) → `data/raw/instagram` |
| 3 | `signal_threads_topics` | Threads 실시간 화제 토픽 스캔 — 니치 관련 화제 대화 수집·요약 | niche | chrome(threads) → validation → write(md) → `data/insights` |
| 4 | `signal_yt_trending` | YouTube 인기급상승 니치 필터링 — 급상승 탭에서 니치 관련 영상 추출 | niche | chrome(youtube) → write(xlsx) → `data/raw/youtube` |
| 5 | `signal_shorts_format` | 쇼츠 상위노출 포맷 패턴 분석 — 니치 쇼츠 12~15편의 구성 공식 도출 | niche, target_keyword | chrome(youtube) → read 분석 → write(md) → `data/insights` |
| 6 | `signal_x_trends_angle` | X 실시간 트렌드 → 브랜드 앵글 도출 — 트렌드 토픽별 브랜드 연결각 제안 | brand_name, niche | chrome → read → write(md) → `data/insights` |
| 7 | `signal_tiktok_cc_trend` | TikTok 크리에이티브센터 트렌드 스캔 — 해시태그·사운드 트렌드 수집 | niche | chrome → write(csv) → `data/raw/tiktok` |
| 8 | `signal_naver_datalab` | 네이버 데이터랩 검색어 트렌드 리포트 — 키워드 추이+연관 급상승어 | niche, seed_keywords | chrome ×2 → validation → write(xlsx) → `data/reports` |
| 9 | `signal_naver_shopping` | 네이버 쇼핑인사이트 카테고리 트렌드 — 카테고리 인기검색어 추이 | category(text) | chrome → write(xlsx) → `data/reports` |
| 10 | `signal_google_trends` | 구글 트렌드 급상승 → 콘텐츠 앵글 — 급상승어 중 니치 관련 기회 도출 | niche, brand_name | chrome → read → write(md) → `data/insights` |
| 11 | `signal_kr_community_memes` | 한국 커뮤니티 화제글·밈 스캔 — 주요 커뮤니티 인기글에서 밈·화제 요약 | niche | chrome(data-scout) → validation → write(md) → `data/insights` |
| 12 | `signal_reddit_hot` | Reddit 니치 서브레딧 핫포스트 스캔 — 서브레딧별 상위 포스트·논점 수집 | subreddits(list) | chrome → write(csv) → `data/insights` |
| 13 | `signal_newsjacking_scan` | 뉴스재킹 기회 스캔 — 포털 헤드라인에서 브랜드가 올라탈 이슈 선별 | brand_name, niche | chrome → read → write(md) → `data/insights` |
| 14 | `signal_meme_tracker` | 주간 밈 트래커 — 이번 주 밈의 발원지·확산 경로·수명 단계 기록 | niche | chrome(data-scout) → write(md) → `data/insights` |
| 15 | `signal_season_calendar` | 시즌·기념일 30일 기회 캘린더 — 향후 30일 기념일/시즌별 콘텐츠 앵글 | brand_name, niche | read → write(csv) → `strategies` |
| 16 | `signal_micro_influencer` | 급성장 마이크로 인플루언서 발굴 — 니치 내 1만~10만 급성장 계정 리스트 | niche, hashtags | chrome(instagram) → validation → write(xlsx) → `data/reports` |
| 17 | `signal_sound_challenge` | 바이럴 사운드·챌린지 조기 감지 — IG·TikTok 교차로 초기 확산 신호 포착 | niche | chrome ×2 → write(md) → `data/insights` |
| 18 | `signal_serp_gap` | 니치 키워드 SERP 콘텐츠 갭 스캔 — 상위 결과가 못 채운 주제 공백 발굴 | target_keyword, niche | chrome(seo-crawl) → read → write(md) → `data/insights` |

## B. 경쟁·벤치마크 분석 (15) — 태그 `research`

| # | slug | 제목 — 설명 | 입력 | 노드 체인 → outputDir |
|---|---|---|---|---|
| 19 | `bench_ig_competitor_deep` | 경쟁사 IG 계정 정밀 분석 — 최근 30포스트 참여 패턴·승자 포맷 해부 | account_url, brand_name | chrome(instagram) ×2(15+15) → validation → write(xlsx) → `data/reports` |
| 20 | `bench_reels_hooks` | 경쟁 릴스 훅 문장 수집·분류 — 경쟁 릴스 첫 3초 훅을 유형별 분류 | competitor_urls | chrome(instagram) → read 분류 → write(md) → `data/insights` |
| 21 | `bench_threads_pattern` | 경쟁사 Threads 운영 패턴 분석 — 포스팅 빈도·톤·반응 패턴 | account_url | chrome(threads) → write(md) → `data/insights` |
| 22 | `bench_yt_channel_strategy` | 경쟁 YT 채널 콘텐츠 전략 해부 — 업로드 주기·제목 패턴·조회 분포 | channel_url(url) | chrome(youtube) → validation → write(xlsx) → `data/reports` |
| 23 | `bench_yt_outliers` | YT 아웃라이어 영상 발굴 — 구독자 대비 조회수 이상치 영상과 공통점 | niche, seed_channels | chrome(youtube) → validation → read → write(xlsx) → `data/reports` |
| 24 | `bench_shorts_vs_long` | 쇼츠 vs 롱폼 비율·성과 벤치마크 — 니치 채널들의 포맷 믹스 비교 | seed_channels | chrome(youtube) → read → write(md) → `data/insights` |
| 25 | `bench_x_viral_posts` | 경쟁 브랜드 X 바이럴 포스트 해부 — 고반응 포스트의 구조·타이밍 분석 | account_url | chrome → read → write(md) → `data/insights` |
| 26 | `bench_naver_blog_top` | 경쟁사 네이버 블로그 상위노출 분석 — 키워드별 상위글 구조 해부 | target_keyword | chrome(seo-crawl) → write(xlsx) → `data/reports` |
| 27 | `bench_community_sentiment` | 브랜드·경쟁사 커뮤니티 여론 분석 — 언급 수집, 호감/불만 포인트 정리 | brand_name, competitor_names(list) | chrome(data-scout) → read → write(md) → `data/insights` |
| 28 | `bench_growth_reverse` | 벤치마크 계정 그로스 리버스엔지니어링 — 성장 구간별 콘텐츠 매핑 | account_url | chrome → read → write(md) → `data/insights` |
| 29 | `bench_ugc_campaigns` | 경쟁 UGC·해시태그 캠페인 벤치마크 — 캠페인 태그 참여 규모·구조 | campaign_hashtags(list) | chrome(instagram) → write(md) → `data/insights` |
| 30 | `bench_top10_content_mix` | 카테고리 Top10 계정 콘텐츠 믹스 매트릭스 — 계정×포맷 비율 매트릭스 | niche | chrome(instagram) → validation → write(xlsx) → `data/reports` |
| 31 | `bench_newsletter` | 경쟁 뉴스레터 공개 아카이브 벤치마크 — 제목·구성·CTA 패턴 | archive_urls(list) | chrome → write(md) → `data/insights` |
| 32 | `bench_promo_calendar` | 경쟁사 프로모션 캘린더 역추적 — 공개 채널에서 프로모션 주기 복원 | competitor_urls | chrome → write(csv) → `data/insights` |
| 33 | `bench_viral_case_study` | 바이럴 사례 딥다이브 — 특정 바이럴 건의 타임라인·확산 경로 재구성 | case_url(url) | chrome → read → write(md) → `data/insights` |

## C. 바이럴 전략·기획 (15) — 태그 `campaign`

| # | slug | 제목 — 설명 | 입력 | 노드 체인 → outputDir |
|---|---|---|---|---|
| 34 | `strategy_angle_brainstorm` | 바이럴 앵글 브레인스토밍 30선 — 브랜드×심리 트리거 매트릭스로 앵글 도출 | brand_name, niche, target_audience | read → write(md) → `strategies` |
| 35 | `strategy_persona_profile` | 타겟 심리 프로파일 — 커뮤니티 실사용 언어 수집 기반 페르소나 | niche, target_audience | chrome(data-scout) → write(md) → `strategies` |
| 36 | `strategy_content_pillars` | 콘텐츠 필러 5개 설계 + 배분 비율 — 계정의 기둥 주제와 포맷 믹스 | brand_name, niche | read → write(md) → `strategies` |
| 37 | `strategy_30day_calendar` | 30일 바이럴 콘텐츠 캘린더 — 날짜×채널×필러×훅 30행 캘린더 | brand_name, niche, insights_path | read → write(csv) → validation → `strategies` |
| 38 | `strategy_ugc_challenge` | UGC 챌린지 캠페인 설계 — 참여 규칙·해시태그·리워드·시딩 플랜 | brand_name, target_audience | read → write(md) → `strategies` |
| 39 | `strategy_meme_campaign` | 밈 마케팅 캠페인 기획 — 현재 밈 스캔 결과를 브랜드 적용안으로 | brand_name, memes_path(path) | read → write(md) → `strategies` |
| 40 | `strategy_influencer_seeding` | 인플루언서 시딩 리스트 + 아웃리치 플랜 — 발굴 결과 우선순위화·메시지안 | influencer_list_path(path), brand_name | read → write(xlsx) → `strategies` |
| 41 | `strategy_newsjack_playbook` | 뉴스재킹 24시간 대응 플레이북 — 이슈 검증→각도→채널별 초동 대응안 | issue_topic(text), brand_name | chrome → write(md) → `strategies` |
| 42 | `strategy_launch_sequence` | 티저→공개 런칭 시퀀스 설계 — D-14~D+7 채널별 시퀀스 | brand_name, launch_date(text) | read → write(md) → `strategies` |
| 43 | `strategy_hook_library` | 니치 검증 훅 100개 라이브러리 — 3채널 수집 40 + 패턴 변형 60 | niche | chrome ×3(IG·YT·Threads) → validation → read 확장 → write(csv) → `data/insights` |
| 44 | `strategy_bio_positioning` | 계정 포지셔닝·바이오 최적화 제안 — 현 계정 진단 + 리라이트안 | account_url, brand_name | chrome → write(md) → `strategies` |
| 45 | `strategy_community_seeding` | 커뮤니티별 시딩 전략 — 어느 커뮤니티에 어떤 톤·형식으로 갈지 매핑 | brand_name, niche | read → write(md) → `strategies` |
| 46 | `strategy_referral_loop` | 추천인·리퍼럴 루프 설계 — 공유 유인·보상 구조·마찰 제거 설계 | brand_name, product_desc(text) | read → write(md) → `strategies` |
| 47 | `strategy_risk_check` | 역바이럴 리스크 점검 — 캠페인안의 오독·논란 시나리오와 방어선 | campaign_path(path) | read → write(md) → `strategies` |
| 48 | `strategy_quarter_roadmap` | 분기 바이럴 캠페인 로드맵 — 월별 캠페인 테마·목표·채널 배분 | brand_name, quarter_goal(text) | read → write(md) → `strategies` |

## D. 콘텐츠 제작 (22) — 태그 `content` · outputDir `content/drafts`

이미지 생성 불가 → 비주얼은 전부 "촬영/디자인 지시문" 텍스트로 서술.

| # | slug | 제목 — 설명 | 입력 | 노드 체인 |
|---|---|---|---|---|
| 49 | `create_reels_scripts` | 릴스 스크립트 10개 뱃치 — 훅(3초)+본문+CTA+촬영 지시문 | brand_name, niche, hook_library_path | read 앵글 선정 → write(md) → validation |
| 50 | `create_reels_captions` | 릴스 캡션+해시태그 세트 뱃치 — 스크립트별 캡션·태그 30개 세트 | draft_path | read → write(md) |
| 51 | `create_carousel_copy` | 카루셀 슬라이드 카피 뱃치 — 8~10장 슬라이드×3세트, 장당 문안 | topic, brand_name | read → write(md) |
| 52 | `create_story_interactions` | 스토리 인터랙션 시리즈 — 투표·퀴즈·슬라이더 7일치 문안 | brand_name, niche | read → write(md) |
| 53 | `create_threads_batch` | Threads 포스트 10개 뱃치 — 화제 토픽 스캔 결과 기반 대화형 포스트 | topics_path(path), brand_name | read → write(md) → validation |
| 54 | `create_x_threads_long` | X 장문 타래 뱃치 — 스토리텔링 타래 3편 (각 8~12트윗) | topic, brand_name | read → write(md) |
| 55 | `create_shorts_scripts` | 쇼츠 스크립트 10개 뱃치 — 첫 2초 훅+전개+루프 엔딩 | niche, topic | read → write(md) → validation |
| 56 | `create_yt_longform_script` | 롱폼 대본 + 챕터 타임라인 — 레퍼런스 영상 자막 분석 후 대본 | reference_video_url(url), topic | chrome(youtube-transcript) → write(md) |
| 57 | `create_yt_title_ab` | 제목·썸네일 문구 A/B 10종 — 영상 1편에 제목 10안+썸네일 문구 | video_topic(text) | read → write(md) |
| 58 | `create_tiktok_scripts` | TikTok 스크립트 뱃치 — 트렌드 사운드·포맷에 매핑한 10편 | trends_path(path), brand_name | read → write(md) |
| 59 | `create_naver_blog_post` | 네이버 블로그 상위노출 장문 포스트 — SERP 분석 → 2,000자+ 원고 | target_keyword, brand_name | chrome(seo-crawl) → read 아웃라인 → write(md) → validation |
| 60 | `create_naver_cafe_post` | 네이버 카페 정보성 글 — 커뮤니티 톤의 정보성·후기형 원고 | topic, brand_name | read → write(md) |
| 61 | `create_community_tone_batch` | 커뮤니티 톤 변환 뱃치 — 원문 1개를 커뮤니티별 문체 5종으로 | draft_path | read → write(md) |
| 62 | `create_hook_tweets` | 바이럴 한줄 훅 트윗 30개 — 심리 트리거 유형별 10×3 | brand_name, niche | read → write(md) |
| 63 | `create_newsletter_story` | 스토리텔링 뉴스레터 원고 — 제목 5안+본문+CTA | topic, brand_name | read → write(md) |
| 64 | `create_press_release` | 보도자료 + 기자 피칭 문안 — 배포용 보도자료와 개별 피칭 메일 | announcement(text), brand_name | read → write(pdf) |
| 65 | `create_ugc_remix_script` | UGC 리믹스 각본 — 고객 후기를 릴스/쇼츠 각본으로 변환 | reviews_path(path) | read → write(md) |
| 66 | `create_influencer_brief` | 인플루언서 브리프 문서 — 가이드라인·필수 멘션·금지어 | brand_name, campaign_path(path) | read → write(pdf) |
| 67 | `create_repurpose_matrix` | 리퍼포징 매트릭스 — 롱폼 1편 → 파생 콘텐츠 10개 기획 | reference_video_url(url) | chrome(youtube-transcript) → write(md) |
| 68 | `create_social_proof_copy` | 후기 수집 → 소셜프루프 카피 — 실제 후기 수집 후 카피 변환 | product_url(url) | chrome → read → write(md) |
| 69 | `create_landing_copy` | 랜딩페이지 바이럴 카피 세트 — 헤드라인 10안+섹션 카피 | product_url(url), target_audience | chrome → write(md) |
| 70 | `create_kakao_campaign_copy` | 카카오톡 채널 메시지 캠페인 문안 — 시퀀스 3통+버튼 문구 | brand_name, campaign_goal(text) | read → write(md) |

## E. 확산·실행 (15) — 태그 `social` · execution형

라운드당 10~15건 한도, 자사 계정 투명 운영, 도배·스팸 금지를 각 detail에 명시.
type이 execution으로 파생되도록 마지막 노드는 chrome/app 액션으로 끝내고, 결과는
outputScope로 자체 보고한다 (별도 로그 파일이 필요하면 write 노드를 앞이 아닌
후속 워크플로우로 분리).

| # | slug | 제목 — 설명 | 입력 | 노드 체인 |
|---|---|---|---|---|
| 71 | `amplify_ig_publish` | IG 피드 포스트 발행 — draft 읽고 캡션·태그 확정 후 발행 | draft_path | read → chrome(instagram) 발행 |
| 72 | `amplify_threads_publish` | Threads 포스트 발행 — draft 기반 발행, 게시 URL 보고 | draft_path | read → chrome(threads) |
| 73 | `amplify_ig_comment_round` | IG 타겟 댓글 참여 라운드 — 해시태그 상위 포스트에 가치 댓글 10~12개 | hashtags, brand_voice(text) | chrome 스카우트+초안 → validation → chrome 게시 |
| 74 | `amplify_threads_engage` | Threads 대화 참여 라운드 — 니치 대화에 답글 10~12개 | niche, brand_voice(text) | chrome(threads) 스카우트 → chrome 답글 |
| 75 | `amplify_yt_community_post` | YT 커뮤니티 탭 포스트 발행 — 투표/텍스트 포스트 게시 | draft_path, channel_url(url) | read → chrome(youtube) |
| 76 | `amplify_influencer_dm` | 인플루언서 DM 아웃리치 뱃치 — 시딩 리스트 상위 10~15명 개인화 DM | seeding_list_path(path) | read → validation → chrome(instagram) DM |
| 77 | `amplify_mention_response` | 브랜드 멘션 실시간 대응 라운드 — 멘션 검색 후 답글 10건 | brand_name | chrome(watchtower) 수집 → chrome 답글 |
| 78 | `amplify_community_participate` | 커뮤니티 공식 계정 참여 라운드 — 관련 스레드에 정보성 댓글 (신분 투명) | brand_name, community_urls(list) | read 가이드 → chrome 참여 |
| 79 | `amplify_x_publish_engage` | X 포스트 발행 + 인게이지 — 발행 후 관련 대화 5~10건 참여 | draft_path | read → chrome 발행+참여 |
| 80 | `amplify_crosspost_round` | 크로스포스팅 라운드 — 1콘텐츠를 IG→Threads→X 순차 발행 (채널별 변형) | draft_path | read 변형 → chrome(instagram) → chrome(threads) → chrome X |
| 81 | `amplify_follow_round` | 타겟 오디언스 팔로우·참여 라운드 — 경쟁 팔로워 중 활성 계정 10~15명 | competitor_urls | chrome(instagram) 선별 → chrome 팔로우+좋아요 |
| 82 | `amplify_review_request` | 고객 후기 요청 캠페인 — 카카오톡으로 후기 요청 메시지 발송 | customer_list_path(path) | read → app(kakaotalk) 발송 |
| 83 | `amplify_ugc_thanks_round` | UGC 참여자 감사 라운드 — 캠페인 태그 게시자에 감사 댓글·스토리 언급 | campaign_hashtags(list) | chrome(instagram) 수집 → chrome 댓글 |
| 84 | `amplify_newsletter_upload` | 뉴스레터 발송 준비 — 스티비/메일침프에 원고 업로드·테스트 발송 | draft_path | read → chrome 업로드 |
| 85 | `amplify_gbp_post` | 구글 비즈니스 프로필 포스트 발행 — 소식/오퍼 포스트 게시 | draft_path | read → chrome 발행 |

## F. 측정·최적화 (15) — 태그 `reporting` · outputDir `data/reports`

| # | slug | 제목 — 설명 | 입력 | 노드 체인 |
|---|---|---|---|---|
| 86 | `measure_ig_weekly` | 주간 IG 성과 리포트 — 인사이트 지표 수집 → 주간 xlsx+요약 | account_url | chrome(instagram) → validation → write(xlsx) |
| 87 | `measure_threads_weekly` | 주간 Threads 성과 리포트 — 포스트별 반응 수집·요약 | account_url | chrome(threads) → write(md) |
| 88 | `measure_yt_weekly` | 주간 YT 채널 성과 리포트 — 스튜디오 지표 수집 → xlsx | channel_url(url) | chrome(youtube) → write(xlsx) |
| 89 | `measure_hashtag_ugc` | 캠페인 해시태그 UGC 추적 — 참여 게시물 수·상위 UGC 기록 | campaign_hashtags(list) | chrome(instagram) → write(xlsx) |
| 90 | `measure_follower_tracker` | 팔로워 성장 스냅샷 트래커 — 자사+경쟁 계정 팔로워 수 기록 (누적 csv) | account_urls(list) | chrome → edit(csv 누적) |
| 91 | `measure_content_winners` | 콘텐츠 승자 분석 — 최근 30개 중 상위 10% 공통점 도출 | account_url | chrome ×2 → read → write(md) |
| 92 | `measure_hook_retro` | 훅 성과 회고 — 사용 훅별 성과 매핑 → 훅 라이브러리 갱신 | hook_library_path, account_url | chrome → read → edit(csv) |
| 93 | `measure_best_time` | 최적 발행 시간대 분석 — 포스트 시각×반응 상관 분석 | account_url | chrome(instagram) → read → write(md) |
| 94 | `measure_brand_search` | 브랜드 검색량·멘션 변화 — 데이터랩+구글트렌드 교차 리포트 | brand_name | chrome ×2 → write(xlsx) |
| 95 | `measure_influencer_roi` | 인플루언서 캠페인 ROI — 참여 인플루언서별 도달·반응·전환 정리 | campaign_path(path) | read → chrome → write(xlsx) |
| 96 | `measure_comment_sentiment` | 댓글 감성·토픽 분석 — 최근 포스트 댓글 수집 → 감성/토픽 분류 | account_url | chrome → read → write(md) |
| 97 | `measure_sov_monthly` | 경쟁 대비 SOV 월간 리포트 — 언급 점유율 채널별 비교 | brand_name, competitor_names(list) | chrome(data-scout) → write(xlsx) |
| 98 | `measure_site_traffic` | 사이트 유입·전환 리포트 — GA4 화면 스크랩 → 소셜 유입 분석 | ga_property(text) | chrome → write(md) |
| 99 | `measure_monthly_pack` | 월간 통합 바이럴 리포트 팩 — 전 채널 리포트 취합 → 경영 요약 팩 | brand_name, month_label(text) | read 취합 → validation → write(report-pack) |
| 100 | `measure_content_autopsy` | 저성과 콘텐츠 부검 — 하위 성과 원인 분석 → 개선 규칙 도출 | account_url | chrome → read → write(md) |

---

## 추천 조합 (필러 연결 플레이북)

| 플레이북 | 조합 |
|---|---|
| 주간 릴스 그로스 루프 | #1 트렌드 스캔 → #49 스크립트 뱃치 → #71 발행 → #73 댓글 라운드 → #86 주간 리포트 |
| 네이버 검색 장악 | #8 데이터랩 → #26 상위노출 분석 → #59 블로그 원고 → #94 검색량 추적 |
| 인플루언서 시딩 캠페인 | #16 발굴 → #40 시딩 플랜 → #66 브리프 → #76 DM 아웃리치 → #95 ROI |
| UGC 챌린지 | #38 설계 → #50 캡션 세트 → #83 감사 라운드 → #89 UGC 추적 |
| 콜드스타트 계정 부스트 | #30 믹스 매트릭스 → #44 포지셔닝 → #43 훅 라이브러리 → #37 30일 캘린더 |

## 대표 spec 10개 (`specs/` 폴더)

각 필러를 커버하는 실사용 가능 spec. `specs/wf_viral_*.json` 파일을
` ```workflow-spec ` 펜스로 감싸 Workflow Builder 챗에 붙여넣으면 그대로 생성된다.

| 파일 | # | 필러 |
|---|---|---|
| `wf_viral_signal_ig_reels_trend.json` | 1 | A |
| `wf_viral_signal_naver_datalab.json` | 8 | A |
| `wf_viral_bench_ig_competitor_deep.json` | 19 | B |
| `wf_viral_bench_yt_outliers.json` | 23 | B |
| `wf_viral_strategy_30day_calendar.json` | 37 | C |
| `wf_viral_strategy_hook_library.json` | 43 | C |
| `wf_viral_create_reels_scripts.json` | 49 | D |
| `wf_viral_create_naver_blog_post.json` | 59 | D |
| `wf_viral_amplify_ig_comment_round.json` | 73 | E |
| `wf_viral_measure_monthly_pack.json` | 99 | F |

> **주의**: 빌더 챗의 파서(`parseWorkflowSpecFromText`)는 `title/description/inputs/nodes`만
> 읽고 `outputDir`·`tags`는 무시한다 — 챗으로 넣을 경우 태그는 생성 후 UI에서 지정.
> spec 파일에 두 필드를 포함해 둔 것은 추후 시드(`seedSampleWorkflowsForTeam`의 `mk()`
> 또는 JSON 매니페스트 lazy-seed) 전환 시 그대로 쓰기 위함이다. 100개 규모 시드는
> 시작 비용 때문에 매니페스트 방식 도입을 권장 (`electron/planning.ts:1139` SEED_VERSION 참고).
