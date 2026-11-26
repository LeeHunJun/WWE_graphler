# 로그인 · 팀 워크스페이스

## 로그인 (아이디 + 비밀번호)
- 처음 접속하면 로그인 화면이 나와요. **회원가입**에서 이름(팀원에게 보이는 이름), 아이디(영문·숫자·`_` 4~20자), 비밀번호(6자 이상)를 정하면 프로필이 만들어지고 바로 로그인돼요.
- 로그인은 30일 유지돼요(HttpOnly 쿠키). 오른쪽 위 프로필 메뉴 → **로그아웃**.
- 같은 아이디로 비밀번호를 5번 틀리면 10분 동안 로그인이 막혀요.
- 프로필 편집에서 이름과 비밀번호를 바꿀 수 있어요(비밀번호 변경은 현재 비밀번호 필요). 아이디는 바꿀 수 없어요.
- 비밀번호는 scrypt 해시로만, 로그인 세션은 토큰의 SHA-256 해시로만 서버에 저장해요.

## 팀 워크스페이스
| 기능 | 위치 | 내용 |
| --- | --- | --- |
| 워크스페이스 전환 | 사이드바 위 워크스페이스 버튼 (모바일은 프로필 메뉴) | 내가 속한 워크스페이스 목록, 새 워크스페이스 만들기 |
| 공유 문서 | 문서 목록의 공유 버튼 → 사이드바 **공유 문서** | 읽은 내용·시각화·AI 요약을 팀에 올리고, 팀원은 "내 보관함으로 열기"로 바로 분석 |
| 저장한 인사이트 | 시각화 패널 **인사이트 저장** → 사이드바 **저장한 인사이트** | 그래프 강조(핵심·중요)와 AI 요약 문장을 골라 메모와 함께 저장, "문서 열기"로 원본 이동 |
| 팀 설정 | 사이드바 **팀 설정** | 이름·설명·색상, 공유/저장 권한, 멤버 역할(관리자·편집자·보기 전용), 초대 링크, 나가기/삭제 |

- 처음 로그인하면 기본 워크스페이스 "프로덕트 팀"에 참여해요. 다른 워크스페이스는 **초대 링크**(`?workspace=<id>`)로 들어오면 편집자로 참여해요.
- 내 문서 보관함은 지금처럼 브라우저(IndexedDB)에 저장되고, 계정별로 분리돼요. 로그인 기능 이전에 저장한 문서는 그 브라우저에서 처음 로그인한 계정으로 옮겨져요.

## 서버 저장 위치
- 계정·세션: `<데이터 폴더>/users.json`
- 워크스페이스·멤버·인사이트: `<데이터 폴더>/workspaces.json`
- 공유 문서 본문: `<데이터 폴더>/shared/<id>.json`
- 데이터 폴더는 기본 `.data/`(git 제외), 환경변수 `GRAPPLER_DATA_DIR`로 바꿀 수 있어요.
- **배포 환경 주의:** 서버를 다시 배포할 때 파일이 지워지는 환경이면 계정과 공유 데이터도 사라져요. 유지되는 디스크(볼륨) 경로를 `GRAPPLER_DATA_DIR`로 지정해 주세요.

## API 요약
- `POST /api/auth/signup` `{ name, username, password }` · `POST /api/auth/login` `{ username, password }` · `POST /api/auth/logout` · `GET/PATCH /api/auth/me`
- `GET/POST /api/workspaces`, `GET/PATCH/DELETE /api/workspaces/:id`, `POST /api/workspaces/:id/join`
- `PATCH/DELETE /api/workspaces/:id/members/:memberId`
- `GET/POST /api/workspaces/:id/shared-documents`, `GET/DELETE /api/workspaces/:id/shared-documents/:docId`
- `GET/POST /api/workspaces/:id/insights`, `DELETE /api/workspaces/:id/insights/:insightId`
- 워크스페이스 API는 로그인 쿠키가 필요하고, 다른 사이트(Origin)에서 온 쓰기 요청은 거절해요.
