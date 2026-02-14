# ai-agent-orchestrator

`ai-agent-orchestrator`는 AI 개발 작업을 아티팩트 중심으로 실행하는 CLI/TUI 오케스트레이터다.  
핵심은 `patch-first`(developer/fixer 출력은 diff 우선)와 `safety-first`(allowlist + Gatekeeper 승인)이며, 모든 실행 결과를 `.runs/`에 기록한다.

## 현재 구현 상태

- 완료 Phase: `00~09`
- 핵심 구현:
  - `adt/aao init` 워크스페이스 생성
  - `adt/aao manager refactor "<요청>"` 워크플로 실행
  - Provider 어댑터(`codex-cli`), patch 추출/적용, Gatekeeper 검사/승인/auto-fix
  - TUI 런너(`adt-tui`) 및 회귀 테스트 픽스처
- 미구현/제약:
  - `adt/aao run`은 아직 placeholder
  - `init --force`는 파싱되지만 현재 미지원 에러를 반환
  - 전용 `resume/approve` CLI 커맨드는 아직 없음

## 요구사항

- Node.js `>= 22`
- `pnpm` workspace 환경 권장
- `git` 설치 필요 (patch 적용/변경 분석)
- 실제 LLM 실행 시 `codex` CLI 설치 필요 (`codex-cli` provider 사용 시)

## 개발 명령어

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm format
```

대안:

```bash
npm install
npm run build
npm run test
npm run lint
```

## 빠른 시작

1) CLI 빌드

```bash
pnpm --filter @adt/cli build
```

2) 워크스페이스 초기화 (`ai-dev-team/` 생성)

```bash
node packages/cli/dist/index.js init
```

3) refactor 워크플로 실행

```bash
node packages/cli/dist/index.js manager refactor "함수 분리 및 네이밍 개선"
```

`manager refactor`는 기본적으로 `ai-dev-team/config/workflows/refactor.yaml`을 읽고, run 결과를 `.runs/workflows/<run-id>/`에 기록한다.

## CLI 명령

- `init`
  - 현재 디렉토리에 `ai-dev-team` 워크스페이스 템플릿 생성
- `manager refactor "<요청>"`
  - workflow 실행 + 승인 단계(`y/N`) 처리
- `run`
  - 다음 단계 구현 예정 (현재 메시지 출력만 수행)

바이너리 alias는 `aao`, `adt` 둘 다 지원한다.

## 생성되는 워크스페이스

`init` 실행 시 다음 구조를 생성한다.

```text
ai-dev-team/
├─ artifacts/
├─ roles/
├─ rules/
├─ state/
└─ config/
   ├─ routing.yaml
   ├─ gatekeeper.yaml
   ├─ tools.yaml
   └─ workflows/
      └─ refactor.yaml
```

설정 요약:

- `config/routing.yaml`
  - 기본 provider 선택 (`provider: codex-cli`)
- `config/tools.yaml`
  - allowlist 커맨드 정의 (`id`, `executable`, `args`, `timeout_ms`)
- `config/gatekeeper.yaml`
  - 현재 구현에서 사용하는 키:
    - `auto_fix.max_retries`
    - `checks.command_ids`

## 워크플로/안전 동작

- 기본 phase 흐름: `plan -> approve -> implement -> evaluate -> (fix | ask | review)`
- patch-first 대상 role: `developer`, `fixer`
- patch 입력 허용 형식:
  - ```` ```diff ... ``` ````
  - ```` ```patch ... ``` ````
  - `### PATCH` 섹션
- patch 적용:
  - `git apply --whitespace=nowarn -`
  - 경로 안전성 검사(상대 경로, 상위 디렉토리 탈출 금지)
- Gatekeeper:
  - `git diff --name-status`, `git diff --numstat` 기반 위험 변경 감지
  - 삭제/보안 민감 경로/대규모 변경 시 승인 요청
  - `build/test` 등 검사 실패 시 `maxAutoFixRetries` 내 auto-fix 전이

## 실행 결과 아티팩트

```text
.runs/workflows/<run-id>/
├─ current-run.json
├─ artifacts/
│  └─ <phase>/
│     ├─ iter-0001.raw.txt
│     ├─ iter-0001.plan.md
│     ├─ iter-0001.patch
│     ├─ iter-0001.diffstat.txt
│     ├─ iter-0001.diff.txt
│     ├─ iter-0001.check-build.txt
│     ├─ iter-0001.gatekeeper-risk.json
│     └─ iter-0001.gatekeeper-approval.txt
└─ logs/
   ├─ orchestrator.log
   ├─ provider-<phase>.log
   ├─ gatekeeper-<phase>.log
   └─ tool-runtime.log
```

## TUI 실행

```bash
pnpm --filter @adt/tui build
node packages/tui/dist/index.js "리팩터링 요청"
```

TUI에서 확인 가능한 항목:

- run 상태(`status`, `phase`, `retries`, `last error`)
- 최근 artifact 목록
- 승인 입력 (`1 승인`, `2 거절`, `3 프롬프트 토글`)

## 패키지 구성

- `packages/core`: Orchestrator, Workflow 파서, Artifact/State/Log 저장소, Patch-first, Gatekeeper, CommandRunner
- `packages/providers`: Provider registry + `codex-cli` adapter
- `packages/cli`: `init`, `manager refactor` 명령
- `packages/tui`: 텍스트 기반 런 모니터링/승인 UI

## 관련 문서

- 비전: `docs/vision.md`
- 계약: `docs/contracts.md`
- Phase 프롬프트: `.codex/prompts/`
