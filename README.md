# ai-agent-orchestrator

`ai-agent-orchestrator`는 AI 개발 작업을 아티팩트 중심으로 실행하는 CLI/TUI 오케스트레이터다.  
핵심은 `patch-first`(developer/fixer 출력은 diff 우선)와 `safety-first`(allowlist + Gatekeeper 승인)이며, 실행 결과는 현재 워크스페이스 기준 `.runs/workflows/<run-id>/`에 기록한다.

## 현재 구현 상태

- 완료 Phase: `00~09`
- 핵심 구현:
- `aao init` 워크스페이스 생성
- `aao manager refactor "<요청>"` 워크플로 실행
- `aao manager feature-order-page "<요청>"` 워크플로 추가
- `aao manager feature "<요청>"` 워크플로 템플릿 추가
  - Provider 어댑터(`codex-cli`, `gemini-cli`, `claude-cli`), patch 추출/적용, Gatekeeper 검사/승인/auto-fix
  - 역할별 provider 분업 (`manager/gemini-cli`, `planner/codex-cli`, `developer/claude-cli`, `evaluator/codex-cli`, `fixer/codex-cli`, `reviewer/codex-cli`)
  - TUI 런너(`adt-tui`) 및 회귀 테스트 픽스처
  - `summary.md` 실행 요약 생성 및 phase별 아티팩트 정리
- 미구현/제약:
  - `aao run`은 아직 placeholder
  - `init --force`는 파싱되지만 현재 미지원 에러를 반환
  - 전용 `resume/approve` CLI 커맨드는 아직 없음

## 요구사항

- Node.js `>= 22`
- `pnpm` workspace 환경 권장
- `git` 설치 필요 (patch 적용/변경 분석)
- 실제 LLM 실행 시 CLI 설치 필요 (`codex-cli`, `gemini-cli`, `claude-cli` provider 사용 시)

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
node packages/cli/dist/index.js manager refactor "<요청 내용>"
```

`manager refactor`는 기본적으로 `ai-dev-team/config/workflows/refactor.yaml`을 읽고, run 결과를 `.runs/workflows/<run-id>/`에 기록한다.

3-1) feature-order-page 템플릿 워크플로 실행

```bash
node packages/cli/dist/index.js manager feature-order-page "<요청 내용>"
```

`manager feature-order-page`는 `ai-dev-team/config/workflows/feature-order-page.yaml`을 읽고, 동일한 run 결과 저장 구조를 사용한다.

3-2) feature 워크플로 실행

```bash
node packages/cli/dist/index.js manager feature "<요청 내용>"
```

`manager feature`는 `ai-dev-team/config/workflows/feature.yaml`을 읽고, 승인 후 implement/evaluate/review까지 진행한다.

## CLI 명령

- `init`
  - 현재 디렉토리에 `ai-dev-team` 워크스페이스 템플릿 생성
- `manager refactor "<요청>"`
  - workflow 실행 + 승인 단계(`y/N`) 처리
- `manager feature "<요청>"`
  - feature workflow 실행 + 승인 단계(`y/N`) 처리
- `manager feature-order-page "<요청>"`
  - 기능 템플릿 feature workflow 실행 + 승인 단계(`y/N`) 처리
- `run`
  - 다음 단계 구현 예정 (현재 메시지 출력만 수행)

바이너리는 `aao`를 사용한다.

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
      ├─ refactor.yaml
      ├─ feature-order-page.yaml
      └─ feature.yaml
```

설정 요약:

- `config/routing.yaml`
  - 기본 provider 선택 (`provider: codex-cli`)
  - 기본 역할별 provider 매핑:
    - `manager: gemini-cli`
    - `planner: codex-cli`
    - `developer: claude-cli`
    - `evaluator: codex-cli`
    - `fixer: codex-cli`
    - `reviewer: codex-cli`
- `config/tools.yaml`
  - allowlist 커맨드 정의 (`id`, `executable`, `args`, `timeout_ms`)
- `config/gatekeeper.yaml`
  - 현재 구현에서 사용하는 키:
    - `auto_fix.max_retries`
    - `checks.command_ids`
- `roles/*.md`
  - 현재 워크플로우는 `system_prompt_file`을 읽어 role별 프롬프트를 주입한다.
  - `aao init`은 `packages/cli/templates/roles/*.md`를 기준으로 아래 파일을 생성한다.
    - `planner.md`, `manager.md`, `developer.md`, `evaluator.md`, `fixer.md`, `reviewer.md`, `analyzer.md`, `documenter.md`, `improver.md`
  - 템플릿 파일이 없으면 `aao init`이 실패합니다.

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
├─ summary.md
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

### 최근 요약 포맷 정리

- `실행 phase`: 순차 실행 단계 표시
- `phase 상태`: 각 phase별 완료/실패/대기 상태
- `phase별 아티팩트`: phase별 산출물을 바로 추적
- `위치`: `runDir`, `current-run`, `logs`, `artifacts` 경로 집약

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
- `packages/providers`: Provider registry + `codex-cli`, `gemini-cli`, `claude-cli` adapter

- `packages/cli`: `init`, `manager refactor`, `manager feature`, `manager feature-order-page` 명령
- `packages/tui`: 텍스트 기반 런 모니터링/승인 UI

## Provider 설정

기본 설정(`ai-dev-team/config/routing.yaml`)에서 role별 provider를 아래 형태로 지정한다.

```yaml
provider: codex-cli
roles:
  manager: gemini-cli
  planner: codex-cli
  developer: claude-cli
  evaluator: codex-cli
  fixer: codex-cli
  reviewer: codex-cli
```

## Provider 실행 규칙

`routing.yaml`의 `roles`는 `role -> provider-id` 매핑을 그대로 반영한다.  
허용 가능한 provider-id는 `codex-cli`, `gemini-cli`, `claude-cli`이다.
(`gemini`, `claude`도 하위 호환으로 허용)

CLI 등록된 provider id는 다음을 사용합니다: `codex-cli`, `gemini-cli`, `claude-cli`.
(호환성 차원에서 `gemini`, `claude`도 내부적으로 허용됩니다.)

## 관련 문서

- 비전: `docs/vision.md`
- 계약: `docs/contracts.md`
- Phase 프롬프트: `.codex/prompts/`

## 로컬 산출물 정리

- `ai-dev-team/`와 `.runs/`는 `init`/`manager` 실행 시 생성되는 로컬 산출물이므로 `.gitignore`에 포함되어 있다.
- 필요 시 다음으로 정리 가능하다.
  - `rm -rf ai-dev-team .runs`
