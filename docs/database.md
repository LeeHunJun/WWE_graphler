# SQLite 저장소

## 저장되는 데이터

서버는 계정과 팀 협업 자료를 하나의 SQLite 데이터베이스에 보관합니다.

- 기본 위치: `.data/grappler.sqlite`
- `users`, `sessions`: 가입 계정, 비밀번호 해시, 해시 처리된 로그인 세션
- `workspaces`, `workspace_members`: 팀 공간, 설정, 멤버와 역할
- `shared_documents`: 팀 공유 문서의 목록과 문서 본문
- `insights`: 팀이 저장한 인사이트

비밀번호 원문과 로그인 쿠키 토큰 원문은 저장하지 않습니다. 데이터베이스 파일은 서버에서만 열며, `.data/`는 Git 제외 목록에 들어 있습니다.

## 설정

- `GRAPPLER_DATA_DIR`: 기본 데이터 폴더를 변경합니다. 기존 `users.json`, `workspaces.json`, `shared/` 자료를 이전할 때도 이 폴더를 읽습니다.
- `GRAPPLER_DB_PATH`: SQLite 파일 위치를 직접 지정합니다. 생략하면 `${GRAPPLER_DATA_DIR}/grappler.sqlite`를 사용합니다.

예시:

```text
GRAPPLER_DATA_DIR=/persistent/grappler
GRAPPLER_DB_PATH=/persistent/grappler/grappler.sqlite
```

서버가 처음 시작할 때 기존 JSON 계정·세션·워크스페이스·공유 문서·인사이트를 한 번 가져옵니다. 이전 JSON 원본은 자동 삭제하지 않으므로, 이관 결과를 확인한 뒤 별도로 백업하거나 정리할 수 있습니다.

## 협업과 백업

같은 서버를 사용하는 팀원은 같은 SQLite 파일의 계정과 워크스페이스 자료를 공유합니다. 데이터베이스 파일을 배포 때마다 지우는 환경이라면 영구 저장소나 디스크를 연결하고 `GRAPPLER_DATA_DIR` 또는 `GRAPPLER_DB_PATH`를 그 경로로 지정해야 합니다. 여러 서버 인스턴스를 동시에 운영할 때는 모든 인스턴스가 같은 로컬 영구 디스크를 안전하게 공유하지 못할 수 있으므로, 이 경우에는 PostgreSQL 같은 네트워크 데이터베이스를 사용해야 합니다.

백업은 서버를 멈춘 뒤 `grappler.sqlite`와 SQLite가 생성한 `grappler.sqlite-wal`, `grappler.sqlite-shm` 파일을 함께 복사하는 방식이 안전합니다. 복구도 같은 데이터 폴더에 복사한 뒤 서버를 시작하면 됩니다.
